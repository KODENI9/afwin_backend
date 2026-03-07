export interface UserProfile {
  id?: string;
  user_id: string; // Clerk user ID
  display_name: string;
  balance: number;
  role: 'admin' | 'user';
  referral_code: string;
  referred_by?: string;
  phone?: string;
  pin_code?: string;
  first_deposit_approved?: boolean;
  is_blocked?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Draw {
  id?: string;
  draw_date: string; // YYYY-MM-DD
  status: 'OPEN' | 'CLOSED' | 'RESOLVED';
  totalPool: number;
  multiplier: number; // e.g. 5
  commissionRate?: number; // e.g. 0.10
  winningNumber?: number;
  snapshotTotals?: Record<number, number>; // {1: 1000, 2: 500, ...}
  snapshotHash?: string; // SHA256 of snapshotTotals
  resolvedAt?: string;
  locked?: boolean;
  created_at: string;
  updated_at?: string;
}

// One entry in a multi-number bet: a specific number and its stake
export interface BetEntry {
  number: number;   // 1-9
  amount: number;   // positive CFA
  payout: number;   // 0 until resolved, then amount * multiplier if won
  status: 'pending' | 'won' | 'lost';
}

export interface Bet {
  id?: string;
  user_id: string;
  draw_id: string;
  entries: BetEntry[];    // List of (number, amount) entries
  totalAmount: number;   // Sum of all entry amounts, for quick balance checks
  status: 'pending' | 'won' | 'lost' | 'partial'; // 'partial' if only some entries win
  totalPayout: number;   // Total amount won across all entries
  created_at: string;
  updated_at?: string;
}

export interface Transaction {
  id?: string;
  user_id: string;
  draw_id?: string; // Associated draw for payouts/bets
  type: 'deposit' | 'withdrawal' | 'bet' | 'payout' | 'commission' | 'referral_bonus';
  amount: number;
  provider: string;
  reference?: string;
  sms_content?: string;
  account_details?: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id?: string;
  user_id: string;
  title: string;
  message: string;
  type: 'win' | 'info' | 'system';
  read: boolean;
  created_at: string;
}

export interface Network {
  id?: string;
  name: string;
  ussd_template: string;
  destination_number: string;
  is_active: boolean;
  order: number;
}
