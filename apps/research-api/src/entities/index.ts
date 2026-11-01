import { AgentRun } from './agent-run.entity.js';
import { Artifact } from './artifact.entity.js';
import { Baseline } from './baseline.entity.js';
import { CampaignEvent } from './campaign-event.entity.js';
import { DesignCandidate } from './design-candidate.entity.js';
import { ExperimentTransition } from './experiment-transition.entity.js';
import { Experiment } from './experiment.entity.js';
import { PowerResult } from './power-result.entity.js';
import { ResearchCampaign } from './research-campaign.entity.js';
import { ResearchFinding } from './research-finding.entity.js';
import { ResearchProject } from './research-project.entity.js';
import { SynthesisResult } from './synthesis-result.entity.js';
import { TimingResult } from './timing-result.entity.js';
import { VerificationResult } from './verification-result.entity.js';

export {
  AgentRun,
  Artifact,
  Baseline,
  CampaignEvent,
  DesignCandidate,
  Experiment,
  ExperimentTransition,
  PowerResult,
  ResearchCampaign,
  ResearchFinding,
  ResearchProject,
  SynthesisResult,
  TimingResult,
  VerificationResult,
};

export const researchEntities = [
  AgentRun,
  Artifact,
  Baseline,
  CampaignEvent,
  DesignCandidate,
  Experiment,
  ExperimentTransition,
  PowerResult,
  ResearchCampaign,
  ResearchFinding,
  ResearchProject,
  SynthesisResult,
  TimingResult,
  VerificationResult,
];
