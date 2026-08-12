-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstTradeAt" TIMESTAMP(3),
    "activeWallets" INTEGER NOT NULL DEFAULT 1,
    "vault2" TEXT,
    "pk2" TEXT,
    "vault3" TEXT,
    "pk3" TEXT,
    "vault4" TEXT,
    "pk4" TEXT,
    "vault5" TEXT,
    "pk5" TEXT,
    "priorityLevel" TEXT NOT NULL DEFAULT 'FAST',
    "customPriorityFee" DOUBLE PRECISION NOT NULL DEFAULT 0.001,
    "vaultAddress" TEXT,
    "wasEverPromoGranted" BOOLEAN NOT NULL DEFAULT false,
    "turnkeySubOrgId" TEXT,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "totalVolumeSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isLoyaltyUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "hasReferralDiscount" BOOLEAN NOT NULL DEFAULT false,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "vipTier" TEXT,
    "vipExpiresAt" TIMESTAMP(3),
    "vipSource" TEXT,
    "vipTxSignature" TEXT,
    "vipPurchasedAt" TIMESTAMP(3),
    "isDevSuiteUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "withdrawalPin" TEXT,
    "slippagePercent" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "pendingRewardsSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "creditBalance" INTEGER NOT NULL DEFAULT 5,
    "lifetimeCredits" INTEGER NOT NULL DEFAULT 5,
    "reactionGifsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "startingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "autoSnipeActive" BOOLEAN NOT NULL DEFAULT false,
    "positions" JSONB,
    "forgedSharpe" DOUBLE PRECISION,
    "forgedDrawdown" DOUBLE PRECISION,
    "forgedProfit" DOUBLE PRECISION,
    "forgedRisk" DOUBLE PRECISION,
    "forged24hTrades" INTEGER,
    "forged24hPnl" DOUBLE PRECISION,
    "forgedManual24hCount" INTEGER,
    "forgedManual24hPnl" DOUBLE PRECISION,
    "forgedAuto24hCount" INTEGER,
    "forgedAuto24hPnl" DOUBLE PRECISION,
    "forgedHourlyChart" JSONB,
    "forgedStrat1Name" TEXT,
    "forgedStrat1Pnl" DOUBLE PRECISION,
    "forgedStrat2Name" TEXT,
    "forgedStrat2Pnl" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimTrade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "isBuy" BOOLEAN NOT NULL,
    "amountInSol" DOUBLE PRECISION NOT NULL,
    "profitPercent" DOUBLE PRECISION,
    "realizedPnlSol" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "simStateId" TEXT,

    CONSTRAINT "SimTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "tokenMint" TEXT,
    "packName" TEXT,
    "txSignature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchedToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "devBuySol" DOUBLE PRECISION NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "totalVolumeBumped" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LaunchedToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "isBuy" BOOLEAN NOT NULL,
    "amountInSol" DOUBLE PRECISION NOT NULL,
    "feeChargedSol" DOUBLE PRECISION NOT NULL,
    "affiliateCutSol" DOUBLE PRECISION NOT NULL,
    "loyaltyRebateSol" DOUBLE PRECISION NOT NULL,
    "txSignature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "profitPercent" DOUBLE PRECISION DEFAULT 0,
    "realizedPnlSol" DOUBLE PRECISION DEFAULT 0,
    "strategy" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "amountSol" DOUBLE PRECISION NOT NULL,
    "targetPriceUsd" DOUBLE PRECISION,
    "trailingPercent" DOUBLE PRECISION,
    "takeProfitPercent" DOUBLE PRECISION,
    "dcaIntervalMins" INTEGER,
    "maxBudgetSol" DOUBLE PRECISION,
    "maxHoldMinutes" INTEGER,
    "maxBuys" INTEGER,
    "totalSpentSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoSnipeConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sniperMode" TEXT NOT NULL DEFAULT 'PUMP',
    "amountSol" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "requireSocials" BOOLEAN NOT NULL DEFAULT true,
    "maxDevBuyPercent" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "autoTrailingDropPercent" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "useDeepScoring" BOOLEAN NOT NULL DEFAULT false,
    "autoTakeProfitPercent" DOUBLE PRECISION,
    "minScore" INTEGER NOT NULL DEFAULT 0,
    "minMarketCap" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "maxMarketCap" DOUBLE PRECISION NOT NULL DEFAULT 100000.0,
    "antiDeadCoin" BOOLEAN NOT NULL DEFAULT false,
    "maxBudgetSol" DOUBLE PRECISION,
    "totalSpentSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "snipeDelaySeconds" INTEGER NOT NULL DEFAULT 0,
    "enableDynamicScaling" BOOLEAN NOT NULL DEFAULT false,
    "baseRiskUnitSol" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "maxRiskMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "scaleExponent" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoSnipeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyTradeConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetWallet" TEXT NOT NULL,
    "tradeAmountSol" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "autoTrailingDropPercent" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "autoTakeProfitPercent" DOUBLE PRECISION,
    "copyBuys" BOOLEAN NOT NULL DEFAULT true,
    "copySells" BOOLEAN NOT NULL DEFAULT true,
    "maxTradeSizeSol" DOUBLE PRECISION,
    "slippagePercent" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyTradeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "guildCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rewardDescription" TEXT,
    "feePaidSol" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildMembership" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loyaltyPoints" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "totalVolumeSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "rank" INTEGER,
    "airdropsReceivedSol" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyVipPromo" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotsUsed" INTEGER NOT NULL DEFAULT 0,
    "maxSlots" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyVipPromo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallerPrediction" (
    "id" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "ageMins" DOUBLE PRECISION NOT NULL,
    "liquidity" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "priceChangeM5" DOUBLE PRECISION NOT NULL,
    "hasSocials" BOOLEAN NOT NULL,
    "isRug" BOOLEAN,
    "sourceQuality" TEXT,
    "devLaunchCount" INTEGER,
    "lpLockPct" DOUBLE PRECISION,
    "velocityGrowth" DOUBLE PRECISION,
    "predictedLow" DOUBLE PRECISION NOT NULL,
    "predictedHigh" DOUBLE PRECISION NOT NULL,
    "predictedTimeMins" DOUBLE PRECISION NOT NULL,
    "alertedAt" TIMESTAMP(3) NOT NULL,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "peakPct" DOUBLE PRECISION,
    "peakAtMs" INTEGER,
    "outcome1h" DOUBLE PRECISION,
    "outcome6h" DOUBLE PRECISION,
    "outcome24h" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallerPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallerModelWeights" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coefficients" JSONB NOT NULL,
    "featureNames" JSONB NOT NULL,
    "metrics" JSONB,

    CONSTRAINT "CallerModelWeights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secretKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "User_vault2_key" ON "User"("vault2");

-- CreateIndex
CREATE UNIQUE INDEX "User_pk2_key" ON "User"("pk2");

-- CreateIndex
CREATE UNIQUE INDEX "User_vault3_key" ON "User"("vault3");

-- CreateIndex
CREATE UNIQUE INDEX "User_pk3_key" ON "User"("pk3");

-- CreateIndex
CREATE UNIQUE INDEX "User_vault4_key" ON "User"("vault4");

-- CreateIndex
CREATE UNIQUE INDEX "User_pk4_key" ON "User"("pk4");

-- CreateIndex
CREATE UNIQUE INDEX "User_vault5_key" ON "User"("vault5");

-- CreateIndex
CREATE UNIQUE INDEX "User_pk5_key" ON "User"("pk5");

-- CreateIndex
CREATE UNIQUE INDEX "User_vaultAddress_key" ON "User"("vaultAddress");

-- CreateIndex
CREATE UNIQUE INDEX "User_turnkeySubOrgId_key" ON "User"("turnkeySubOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_telegramId_idx" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "SimState_userId_key" ON "SimState"("userId");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchedToken_tokenAddress_key" ON "LaunchedToken"("tokenAddress");

-- CreateIndex
CREATE INDEX "LaunchedToken_userId_idx" ON "LaunchedToken"("userId");

-- CreateIndex
CREATE INDEX "Trade_userId_idx" ON "Trade"("userId");

-- CreateIndex
CREATE INDEX "Trade_tokenAddress_idx" ON "Trade"("tokenAddress");

-- CreateIndex
CREATE INDEX "Trade_txSignature_idx" ON "Trade"("txSignature");

-- CreateIndex
CREATE INDEX "ActiveOrder_userId_isActive_idx" ON "ActiveOrder"("userId", "isActive");

-- CreateIndex
CREATE INDEX "ActiveOrder_tokenAddress_idx" ON "ActiveOrder"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AutoSnipeConfig_userId_key" ON "AutoSnipeConfig"("userId");

-- CreateIndex
CREATE INDEX "CopyTradeConfig_targetWallet_idx" ON "CopyTradeConfig"("targetWallet");

-- CreateIndex
CREATE INDEX "CopyTradeConfig_userId_idx" ON "CopyTradeConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Guild_ownerId_key" ON "Guild"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Guild_guildCode_key" ON "Guild"("guildCode");

-- CreateIndex
CREATE INDEX "Guild_guildCode_idx" ON "Guild"("guildCode");

-- CreateIndex
CREATE INDEX "GuildMembership_guildId_loyaltyPoints_idx" ON "GuildMembership"("guildId", "loyaltyPoints");

-- CreateIndex
CREATE UNIQUE INDEX "GuildMembership_guildId_userId_key" ON "GuildMembership"("guildId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyVipPromo_date_key" ON "DailyVipPromo"("date");

-- CreateIndex
CREATE UNIQUE INDEX "CallerPrediction_alertKey_key" ON "CallerPrediction"("alertKey");

-- CreateIndex
CREATE INDEX "WebhookConfig_userId_idx" ON "WebhookConfig"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimState" ADD CONSTRAINT "SimState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimTrade" ADD CONSTRAINT "SimTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimTrade" ADD CONSTRAINT "SimTrade_simStateId_fkey" FOREIGN KEY ("simStateId") REFERENCES "SimState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchedToken" ADD CONSTRAINT "LaunchedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveOrder" ADD CONSTRAINT "ActiveOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoSnipeConfig" ADD CONSTRAINT "AutoSnipeConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyTradeConfig" ADD CONSTRAINT "CopyTradeConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guild" ADD CONSTRAINT "Guild_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildMembership" ADD CONSTRAINT "GuildMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookConfig" ADD CONSTRAINT "WebhookConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
