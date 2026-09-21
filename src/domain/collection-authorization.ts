/** Issued by the collection gate (#519), held only for this run. Never inferred from a provider. */
export interface CollectionGrant {
  siteAccountId: string;
  runId: string;
  epoch: number;
  mandateId: string;
  capabilityId: string;
  capabilityUpdatedAt: number;
}
