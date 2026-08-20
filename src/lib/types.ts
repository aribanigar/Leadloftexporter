export interface User {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  avatar_url?: string | null;
}

export interface WorkspaceContext {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: User;
  workspaces: WorkspaceContext[];
  current_workspace_id: string | null;
  // Only ever set once, in the response to /auth/register when a freshly
  // claimed invite code also auto-issued the new user their own API key.
  // Always null/absent from /auth/login and /auth/me.
  issued_api_key?: string | null;
}

export interface PipelineStage {
  id: string;
  name: string;
  slug: string;
  color: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  lead_count: number;
}

export interface CompanyMini {
  id: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  headcount?: number | null;
  description?: string | null;
  phone?: string | null;
}

export interface Lead {
  id: string;
  workspace_id: string;
  owner_id?: string | null;
  stage_id?: string | null;
  company_id?: string | null;
  company?: CompanyMini | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  avatar_url?: string | null;
  headline?: string | null;
  location?: string | null;
  estimated_value?: number | null;
  close_date?: string | null;
  source?: string | null;
  tags?: string[];
  custom?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_activity_at?: string | null;
}

export interface LeadList {
  items: Lead[];
  total: number;
  page: number;
  page_size: number;
}

export interface SavedView {
  id: string;
  name: string;
  icon?: string | null;
  filters: Record<string, unknown>;
  columns: string[];
  sort: { field?: string; dir?: "asc" | "desc" };
  is_shared: boolean;
  user_id?: string | null;
  position: number;
}

export interface LeadField {
  id: string;
  key: string;
  label: string;
  type: string;
  options: Record<string, unknown>;
  position: number;
  visible_default: boolean;
  is_system: boolean;
}

export interface Template {
  id: string;
  name: string;
  channel: string;
  subject?: string | null;
  body: string;
  variables: string[];
}

export interface PlaybookStep {
  id: string;
  position: number;
  kind: string;
  wait_days: number;
  wait_hours: number;
  config: Record<string, unknown>;
  template_id?: string | null;
}

export interface Playbook {
  id: string;
  name: string;
  description?: string | null;
  is_active: boolean;
  trigger: string;
  trigger_config: Record<string, unknown>;
  daily_enrollment_limit: number;
  track_opens: boolean;
  contact_unverified: boolean;
  eject_on_reply: boolean;
  fallback_to_email_domain: boolean;
  find_phone_numbers: boolean;
  on_positive_reply_stage?: string | null;
  on_negative_reply_stage?: string | null;
  on_no_reply_stage?: string | null;
  steps: PlaybookStep[];
  enrolled_count: number;
}

export interface Task {
  id: string;
  title: string;
  notes?: string | null;
  type: string;
  status: string;
  due_at?: string | null;
  completed_at?: string | null;
  lead_id?: string | null;
  assignee_id?: string | null;
  created_at: string;
}

export interface OutreachSettings {
  email_sending_pattern: string;
  schedule: string;
  time_frame_start: string;
  time_frame_end: string;
  timezone: string;
  email_limit_per_day: number;
  linkedin_connect_limit: number;
  linkedin_message_limit: number;
}
