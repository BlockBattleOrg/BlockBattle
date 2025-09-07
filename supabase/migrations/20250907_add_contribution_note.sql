-- Add optional public message to contributions
ALTER TABLE public.contributions
ADD COLUMN IF NOT EXISTS note text;

-- Conditionally add a length check constraint (Postgres does not support IF NOT EXISTS here)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contributions_note_length_chk'
      AND conrelid = 'public.contributions'::regclass
  ) THEN
    ALTER TABLE public.contributions
    ADD CONSTRAINT contributions_note_length_chk
    CHECK (note IS NULL OR char_length(note) <= 280);
  END IF;
END$$;

