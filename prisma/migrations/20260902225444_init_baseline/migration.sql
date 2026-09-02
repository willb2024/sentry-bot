-- DropForeignKey
ALTER TABLE "GuildMembership" DROP CONSTRAINT "GuildMembership_guildId_fkey";

-- DropForeignKey
ALTER TABLE "GuildMembership" DROP CONSTRAINT "GuildMembership_userId_fkey";

-- AlterTable
ALTER TABLE "ActiveOrder" ADD COLUMN     "strategy" TEXT NOT NULL DEFAULT 'Manual / Direct';

-- AlterTable
ALTER TABLE "AutoSnipeConfig" ADD COLUMN     "maxLossPercent" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "GuildMembership" ADD COLUMN     "simLoyaltyPoints" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "simTotalVolumeSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "LaunchedToken" ADD COLUMN     "isSimulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SimState" ADD COLUMN     "maxBudgetSol" DOUBLE PRECISION,
ADD COLUMN     "sessionSpendSol" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "aiScore" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "enableAdaptiveSlippage" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableSOR" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lifetimeEarnedSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
ADD COLUMN     "withdrawalPinRecovery" TEXT,
ALTER COLUMN "creditBalance" SET DEFAULT 25,
ALTER COLUMN "lifetimeCredits" SET DEFAULT 25;

-- CreateTable
CREATE TABLE "GuardRecommendation" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "trailingDrop" DOUBLE PRECISION NOT NULL,
    "takeProfit" DOUBLE PRECISION NOT NULL,
    "ageMins" DOUBLE PRECISION NOT NULL,
    "liquidity" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "priceChangeM5" DOUBLE PRECISION NOT NULL,
    "hasSocials" BOOLEAN NOT NULL,
    "isRug" BOOLEAN NOT NULL,
    "lpLockPct" DOUBLE PRECISION NOT NULL,
    "velocityGrowth" DOUBLE PRECISION NOT NULL,
    "sentiment" DOUBLE PRECISION NOT NULL,
    "predictedRange" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "outcomePnlPercent" DOUBLE PRECISION,
    "outcomePeakPercent" DOUBLE PRECISION,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardModelWeights" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coefficients" JSONB NOT NULL,
    "featureNames" JSONB NOT NULL,
    "normalization" JSONB,
    "metrics" JSONB,

    CONSTRAINT "GuardModelWeights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyTradeFollow" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyTradeFollow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateEarning" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountSol" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "fromUser" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateEarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardRecommendation_telegramId_tokenAddress_idx" ON "GuardRecommendation"("telegramId", "tokenAddress");

-- CreateIndex
CREATE INDEX "CopyTradeFollow_leaderId_idx" ON "CopyTradeFollow"("leaderId");

-- CreateIndex
CREATE INDEX "CopyTradeFollow_followerId_idx" ON "CopyTradeFollow"("followerId");

-- CreateIndex
CREATE UNIQUE INDEX "CopyTradeFollow_leaderId_followerId_key" ON "CopyTradeFollow"("leaderId", "followerId");

-- CreateIndex
CREATE INDEX "AffiliateEarning_userId_createdAt_idx" ON "AffiliateEarning"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CopyTradeFollow" ADD CONSTRAINT "CopyTradeFollow_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyTradeFollow" ADD CONSTRAINT "CopyTradeFollow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateEarning" ADD CONSTRAINT "AffiliateEarning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
