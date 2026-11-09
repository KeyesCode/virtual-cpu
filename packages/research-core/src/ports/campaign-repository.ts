import type { CampaignEventType, CampaignStatus } from '../domain/campaign.js';

/** The orchestration view of a campaign: enough to know whether its experiments may still run. */
export interface CampaignRecord {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
}

export interface CampaignEventInput {
  readonly campaignId: string;
  readonly experimentId?: string | null;
  readonly type: CampaignEventType;
  readonly actor: string;
  readonly details?: Record<string, unknown>;
}

export interface CampaignRepository {
  load(id: string): Promise<CampaignRecord | null>;
  /** Append to the campaign's audit trail. */
  appendEvent(event: CampaignEventInput): Promise<void>;
}
