DELETE FROM "Trade" a USING "Trade" b
WHERE a."txSignature" = b."txSignature"
  AND a."txSignature" <> ''
  AND a.ctid > b.ctid;

DROP INDEX IF EXISTS "Trade_txSignature_idx";

CREATE UNIQUE INDEX "Trade_txSignature_key"
  ON "Trade" ("txSignature") WHERE "txSignature" <> '';