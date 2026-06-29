// Ledger insight derivation (issue #161, RFC-002 §5.3): compute the cross-cutting
// filters and the initial Reflection purely from the Disclosure ledger held by
// the DomainService. Deterministic and side-effect-free so it is unit-testable
// without Electron, and so the result is a sanitized view (references / counts /
// masked snippets) the renderer can show. No raw values are produced here.

import type { DomainService } from "./domain-service.js";
import type { Evidence } from "./entities.js";
import type {
  EvidenceRef,
  LedgerFilter,
  LedgerFilterSite,
  LedgerInsights,
  ReflectionFinding,
} from "./insights-types.js";

/** A site with this many or more disclosed attributes is flagged over-disclosed. */
const OVER_DISCLOSED_THRESHOLD = 5;

/** Attribute roots treated as contact / payment data for the stale filter. */
const CONTACT_ROOTS = ["phone", "address", "card"] as const;

function isContactAttribute(attributeKey: string): boolean {
  return CONTACT_ROOTS.some((root) => attributeKey === root || attributeKey.startsWith(`${root}.`));
}

/** Resolve evidence ids to sanitized refs, skipping ids with no Evidence record. */
function toEvidenceRefs(ids: readonly string[], byId: Map<string, Evidence>): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const id of ids) {
    const evidence = byId.get(id);
    if (!evidence) continue;
    const ref: EvidenceRef = { evidenceId: id };
    if (evidence.pageUrl !== undefined) ref.pageUrl = evidence.pageUrl;
    if (evidence.fieldLabel !== undefined) ref.fieldLabel = evidence.fieldLabel;
    if (evidence.maskedSnippet !== undefined) ref.maskedSnippet = evidence.maskedSnippet;
    refs.push(ref);
  }
  return refs;
}

/**
 * Derive the cross-cutting filters and initial Reflection from the ledger. The
 * four filters are always present (possibly with no sites) so the UI shows the
 * categories; the Reflection lists only the findings that actually occur.
 */
export function computeLedgerInsights(domain: DomainService): LedgerInsights {
  const evidenceById = new Map<string, Evidence>();
  for (const evidence of domain.listEvidence()) evidenceById.set(evidence.id, evidence);

  const newsletterSites: LedgerFilterSite[] = [];
  const billingSites: LedgerFilterSite[] = [];
  const staleContactSites: LedgerFilterSite[] = [];
  const stalledSites: LedgerFilterSite[] = [];

  let staleSiteCount = 0;
  let overDisclosedCount = 0;

  for (const site of domain.listSiteAccounts()) {
    const disclosures = domain.listDisclosuresForSite(site.id);
    const relationships = domain
      .listAccountRelationshipsForSite(site.id)
      .filter((r) => r.state === "active");
    const constraints = domain.listConstraints().filter((c) => c.siteAccountId === site.id);
    const checkpoint = domain.getCheckpoint("visibility", site.id);
    const base = { siteAccountId: site.id, displayName: site.displayName, domain: site.domain };

    if (disclosures.some((d) => d.staleState === "stale")) staleSiteCount++;
    // Count distinct disclosed attributes, not raw rows: re-collection appends a
    // new Disclosure per scan, so counting rows would falsely inflate this.
    const distinctAttributes = new Set(disclosures.map((d) => d.attributeKey)).size;
    if (distinctAttributes >= OVER_DISCLOSED_THRESHOLD) overDisclosedCount++;

    const newsletter = relationships.find((r) => r.kind === "newsletter");
    if (newsletter) {
      newsletterSites.push({
        ...base,
        reason: "ニュースレター購読が有効の可能性があります。",
        nextAction: "購読の停止を検討します（後続スライスで対応）。",
        evidence: toEvidenceRefs(newsletter.evidenceIds, evidenceById),
      });
    }

    const billing = relationships.filter((r) => r.kind === "recurring-billing" || r.kind === "free-trial");
    if (billing.length > 0) {
      const hasTrial = billing.some((r) => r.kind === "free-trial");
      billingSites.push({
        ...base,
        reason: hasTrial
          ? "無料トライアルまたは継続課金が検出されました。"
          : "継続課金が検出されました。",
        nextAction: "課金状況を確認します（後続スライスで対応）。",
        evidence: toEvidenceRefs(billing.flatMap((r) => r.evidenceIds), evidenceById),
      });
    }

    const staleContact = disclosures.filter((d) => d.staleState === "stale" && isContactAttribute(d.attributeKey));
    if (staleContact.length > 0) {
      const keys = [...new Set(staleContact.map((d) => d.attributeKey))].join("、");
      staleContactSites.push({
        ...base,
        reason: `連絡先・カード情報が古い可能性があります（${keys}）。`,
        nextAction: "最新の値への更新を検討します（後続スライスの一括更新で対応）。",
        evidence: toEvidenceRefs(staleContact.flatMap((d) => d.evidenceIds), evidenceById),
      });
    }

    // "Stalled" means a run was attempted and stopped at a wall / unknown / failure
    // — NOT a freshly-imported site that has never been collected (that is just
    // "未収集" in the ledger). Conflating them would flag every imported site here.
    const wallOrUnknown = constraints.filter((c) => c.kind === "wall" || c.kind === "unknown-state");
    const stalledByCheckpoint = checkpoint?.status === "handoff" || checkpoint?.status === "failed";
    if (wallOrUnknown.length > 0 || stalledByCheckpoint) {
      stalledSites.push({
        ...base,
        reason: "収集が完了していません（ウォール / ログイン未完了 / 到達不可 / 情報なしなど）。詳細は要確認をご確認ください。",
        nextAction: "サイトを開いて状態を確認し、必要に応じて再収集します。",
        evidence: toEvidenceRefs(wallOrUnknown.flatMap((c) => c.evidenceIds), evidenceById),
      });
    }
  }

  const filters: LedgerFilter[] = [
    { key: "newsletter", label: "ニュースレターが有効なサイト", sites: newsletterSites },
    { key: "billing", label: "継続課金・無料トライアルのサイト", sites: billingSites },
    { key: "stale-contact", label: "連絡先・カードが古いサイト", sites: staleContactSites },
    { key: "stalled", label: "収集が止まっている（未確認の）サイト", sites: stalledSites },
  ];

  const allFindings: ReflectionFinding[] = [
    { kind: "stale", summary: `${staleSiteCount} 件のサイトで、登録値が最新の値と異なる可能性があります。`, count: staleSiteCount },
    { kind: "newsletter", summary: `${newsletterSites.length} 件のサイトでニュースレター購読が有効の可能性があります。`, count: newsletterSites.length },
    { kind: "billing", summary: `${billingSites.length} 件のサイトで継続課金または無料トライアルが検出されました。`, count: billingSites.length },
    { kind: "over-disclosed", summary: `${overDisclosedCount} 件のサイトに多くの個人情報を開示しています。`, count: overDisclosedCount },
    { kind: "stalled", summary: `${stalledSites.length} 件のサイトで収集が途中で止まっており、未確認です。`, count: stalledSites.length },
  ];
  const reflection = allFindings.filter((finding) => finding.count > 0);

  return { filters, reflection };
}
