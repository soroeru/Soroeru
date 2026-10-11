/**
 * Pure state machine for page-operation leases (Issue #558). A lease binds one Side Panel
 * (ownerPort) to one tab, origin, and optional site scope for one epoch. The registry holds no
 * chrome.* dependency so it is unit-testable; the worker persists only `LeaseMetadata`
 * (never ownerPort, URLs, or page values) to chrome.storage.session.
 */

import {
  isOriginInLeaseScope,
  type LeaseInvalidReason,
  type PageRejectedReason,
} from "../src/shared/extension-messages.js";

export interface LeaseMetadata {
  leaseId: string;
  tabId: number;
  origin: string;
  siteDomain?: string;
  epoch: number;
  bootId: string;
}

export interface Lease<Owner = unknown> extends LeaseMetadata {
  ownerPort: Owner;
}

export interface LeaseOpenRequest<Owner> {
  tabId: number;
  origin: string;
  siteDomain?: string | undefined;
  ownerPort: Owner;
}

export interface LeaseInvalidation<Owner = unknown> {
  lease: Lease<Owner>;
  reason: LeaseInvalidReason;
}

export interface LeaseRegistryOptions {
  bootId: string;
  /** Injectable id source so tests are deterministic. */
  newLeaseId?: () => string;
}

export class LeaseRegistry<Owner = unknown> {
  readonly bootId: string;
  private readonly leases = new Map<string, Lease<Owner>>();
  private readonly newLeaseId: () => string;

  constructor(options: LeaseRegistryOptions) {
    this.bootId = options.bootId;
    this.newLeaseId = options.newLeaseId ?? (() => crypto.randomUUID());
  }

  /**
   * Open a lease. A tab or an owner holds at most one lease, so any earlier lease on the same
   * tab or owner is superseded (and returned so the caller can notify and revoke it).
   */
  open(request: LeaseOpenRequest<Owner>): { lease: Lease<Owner>; superseded: LeaseInvalidation<Owner>[] } {
    const superseded = [
      ...this.invalidateWhere((lease) => lease.tabId === request.tabId, "superseded"),
      ...this.invalidateWhere((lease) => lease.ownerPort === request.ownerPort, "superseded"),
    ];
    const lease: Lease<Owner> = {
      leaseId: this.newLeaseId(),
      tabId: request.tabId,
      origin: request.origin,
      ...(request.siteDomain === undefined ? {} : { siteDomain: request.siteDomain }),
      epoch: 0,
      bootId: this.bootId,
      ownerPort: request.ownerPort,
    };
    this.leases.set(lease.leaseId, lease);
    return { lease, superseded };
  }

  get(leaseId: string): Lease<Owner> | undefined {
    return this.leases.get(leaseId);
  }

  byTab(tabId: number): Lease<Owner> | undefined {
    return [...this.leases.values()].find((lease) => lease.tabId === tabId);
  }

  byOwner(ownerPort: Owner): Lease<Owner> | undefined {
    return [...this.leases.values()].find((lease) => lease.ownerPort === ownerPort);
  }

  list(): Lease<Owner>[] {
    return [...this.leases.values()];
  }

  /** Advance the epoch after a navigation / content-script rebind; earlier-epoch commands are stale. */
  bumpEpoch(leaseId: string): Lease<Owner> | undefined {
    const lease = this.leases.get(leaseId);
    if (!lease) return undefined;
    lease.epoch += 1;
    return lease;
  }

  /** Check a command against the lease; returns "ok" or the rejection reason. */
  verify(leaseId: string, epoch: number, ownerPort?: Owner): "ok" | PageRejectedReason {
    const lease = this.leases.get(leaseId);
    if (!lease) return "no-lease";
    if (ownerPort !== undefined && lease.ownerPort !== ownerPort) return "lease-mismatch";
    if (lease.epoch !== epoch) return "stale-epoch";
    return "ok";
  }

  isInScope(leaseId: string, pageOrigin: string): boolean {
    const lease = this.leases.get(leaseId);
    return lease !== undefined && isOriginInLeaseScope(pageOrigin, lease);
  }

  invalidate(leaseId: string, reason: LeaseInvalidReason): LeaseInvalidation<Owner> | undefined {
    const lease = this.leases.get(leaseId);
    if (!lease) return undefined;
    this.leases.delete(leaseId);
    return { lease, reason };
  }

  invalidateByTab(tabId: number, reason: LeaseInvalidReason): LeaseInvalidation<Owner>[] {
    return this.invalidateWhere((lease) => lease.tabId === tabId, reason);
  }

  invalidateByOwner(ownerPort: Owner, reason: LeaseInvalidReason): LeaseInvalidation<Owner>[] {
    return this.invalidateWhere((lease) => lease.ownerPort === ownerPort, reason);
  }

  /** Invalidate leases whose origin / site scope matches a removed host permission origin. */
  invalidateByPermissionOrigin(removedOrigin: string): LeaseInvalidation<Owner>[] {
    return this.invalidateWhere(
      (lease) => lease.origin === removedOrigin || isOriginInLeaseScope(removedOrigin, lease),
      "permission-removed",
    );
  }

  /** Metadata-only view that is safe to persist in chrome.storage.session. */
  snapshot(): LeaseMetadata[] {
    return this.list().map(({ ownerPort: _ownerPort, ...metadata }) => metadata);
  }

  private invalidateWhere(
    predicate: (lease: Lease<Owner>) => boolean,
    reason: LeaseInvalidReason,
  ): LeaseInvalidation<Owner>[] {
    const out: LeaseInvalidation<Owner>[] = [];
    for (const lease of [...this.leases.values()]) {
      if (!predicate(lease)) continue;
      this.leases.delete(lease.leaseId);
      out.push({ lease, reason });
    }
    return out;
  }
}

/**
 * Leases persisted by a previous worker boot cannot be resumed: their ownerPort is gone.
 * Returns those from an earlier bootId so the worker can revoke them in their tabs.
 */
export function staleLeasesFromStorage(stored: unknown, currentBootId: string): LeaseMetadata[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(isLeaseMetadata).filter((lease) => lease.bootId !== currentBootId);
}

function isLeaseMetadata(value: unknown): value is LeaseMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.leaseId === "string" &&
    typeof v.tabId === "number" &&
    typeof v.origin === "string" &&
    (v.siteDomain === undefined || typeof v.siteDomain === "string") &&
    typeof v.epoch === "number" &&
    typeof v.bootId === "string"
  );
}
