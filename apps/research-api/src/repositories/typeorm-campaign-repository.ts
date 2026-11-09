import type {
  CampaignEventInput,
  CampaignRecord,
  CampaignRepository,
  CampaignStatus,
} from '@vcpu/research-core';
import type { DataSource } from 'typeorm';
import { newId } from '../entities/new-id.js';

/** The campaign view the orchestration worker needs, on PostgreSQL. */
export class TypeOrmCampaignRepository implements CampaignRepository {
  constructor(private readonly dataSource: DataSource) {}

  async load(id: string): Promise<CampaignRecord | null> {
    const rows: { id: string; name: string; status: CampaignStatus }[] =
      await this.dataSource.query(`SELECT id, name, status FROM research_campaign WHERE id = $1`, [
        id,
      ]);
    return rows[0] ?? null;
  }

  async appendEvent(event: CampaignEventInput): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO campaign_event (id, campaign_id, experiment_id, type, actor, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newId(),
        event.campaignId,
        event.experimentId ?? null,
        event.type,
        event.actor,
        JSON.stringify(event.details ?? {}),
      ],
    );
  }
}
