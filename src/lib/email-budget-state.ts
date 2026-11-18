// Reads the email budget counters from the database (server only: uses the service role).
// The worker uses it before every send; the dashboard and the admin page use it for the meter.
import { type BudgetState } from '@/lib/email-budget';
import { supabaseAdmin } from '@/lib/supabase/admin';

export interface BudgetSnapshot {
  state: BudgetState;
  userSentToday: number;
  /** New, not-yet-trusted accounts share a small daily pool (D-27). */
  restricted: boolean;
}

export async function loadBudget(userId: string | null): Promise<BudgetSnapshot> {
  const db = supabaseAdmin();
  const [state, control] = await Promise.all([
    db.rpc('email_budget_state', { p_user: userId }),
    userId ? db.from('account_controls').select('trust_level').eq('user_id', userId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const s = Array.isArray(state.data) ? state.data[0] : null;
  if (state.error || !s) throw new Error('email budget unavailable');
  return {
    state: {
      sentTodayAuth: s.sent_today_auth,
      sentTodayShared: s.sent_today_shared,
      sentMonthBeforeToday: s.sent_month_before_today,
      daysLeftInMonth: s.days_left_in_month,
      restrictedSentToday: s.restricted_sent_today,
      providerClosed: s.provider_closed,
    },
    userSentToday: s.user_sent_today ?? 0,
    restricted: (control.data?.trust_level as string | undefined) === 'restricted',
  };
}
