-- Key/value store used by Vercel serverless functions to replace Netlify Blobs.
-- Keys: live-output, live-api, results, odds-api
CREATE TABLE IF NOT EXISTS public.kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.kv IS 'JSON KV store for World Cup knockout app state (scores, results, odds)';

-- Prediction vote tallies
CREATE TABLE IF NOT EXISTS public.match_predictions (
  match_id integer PRIMARY KEY,
  home_votes integer NOT NULL DEFAULT 0,
  draw_votes integer NOT NULL DEFAULT 0,
  away_votes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.match_predictions IS 'Aggregated prediction votes per match';

-- Per-voter record to enforce one vote per IP hash per match
CREATE TABLE IF NOT EXISTS public.match_votes (
  match_id integer NOT NULL,
  ip_hash text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('home', 'draw', 'away')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, ip_hash)
);

COMMENT ON TABLE public.match_votes IS 'Individual votes to enforce one vote per visitor per match';

-- Cast or update a vote for a match.
-- Returns current tallies; returns error='already_voted' if this ip_hash already voted.
CREATE OR REPLACE FUNCTION public.cast_vote(
  p_match_id integer,
  p_ip_hash text,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing_choice text;
BEGIN
  -- Reject invalid choices
  IF p_choice NOT IN ('home', 'draw', 'away') THEN
    RETURN jsonb_build_object('error', 'invalid_choice');
  END IF;

  -- Check for existing vote
  SELECT choice INTO existing_choice
  FROM public.match_votes
  WHERE match_id = p_match_id AND ip_hash = p_ip_hash;

  IF existing_choice IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_voted');
  END IF;

  -- Record the vote
  INSERT INTO public.match_votes (match_id, ip_hash, choice)
  VALUES (p_match_id, p_ip_hash, p_choice);

  -- Upsert the tally, incrementing the appropriate column
  INSERT INTO public.match_predictions (match_id, home_votes, draw_votes, away_votes)
  VALUES (
    p_match_id,
    CASE WHEN p_choice = 'home' THEN 1 ELSE 0 END,
    CASE WHEN p_choice = 'draw' THEN 1 ELSE 0 END,
    CASE WHEN p_choice = 'away' THEN 1 ELSE 0 END
  )
  ON CONFLICT (match_id) DO UPDATE SET
    home_votes = public.match_predictions.home_votes + EXCLUDED.home_votes,
    draw_votes = public.match_predictions.draw_votes + EXCLUDED.draw_votes,
    away_votes = public.match_predictions.away_votes + EXCLUDED.away_votes,
    updated_at = now();

  RETURN jsonb_build_object(
    'home_votes', (SELECT home_votes FROM public.match_predictions WHERE match_id = p_match_id),
    'draw_votes', (SELECT draw_votes FROM public.match_predictions WHERE match_id = p_match_id),
    'away_votes', (SELECT away_votes FROM public.match_predictions WHERE match_id = p_match_id)
  );
END;
$$;
