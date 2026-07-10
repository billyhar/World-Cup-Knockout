-- Lock down the World Cup tables with RLS so anonymous clients can't spam or
-- abuse them. The Vercel functions use the service_role key for kv writes and
-- the anon key for public prediction reads; writes to predictions go through
-- the cast_vote RPC, which now runs with definer privileges to bypass RLS.

-- KV store: server-side only (service_role). No anon access.
ALTER TABLE public.kv ENABLE ROW LEVEL SECURITY;

-- match_predictions: public read-only tally.
ALTER TABLE public.match_predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous read on match_predictions"
  ON public.match_predictions
  FOR SELECT
  TO anon
  USING (true);

-- match_votes: never exposed; only the cast_vote RPC may write.
ALTER TABLE public.match_votes ENABLE ROW LEVEL SECURITY;

-- Make cast_vote run as its owner so it can write to the tally/vote tables
-- even though anon has no direct write policies.
ALTER FUNCTION public.cast_vote(p_match_id integer, p_ip_hash text, p_choice text)
  SECURITY DEFINER;

-- Set a stable search_path on the RPC to avoid search_path injection.
ALTER FUNCTION public.cast_vote(p_match_id integer, p_ip_hash text, p_choice text)
  SET search_path = public;
