// scripts/seed-load-test-users.ts
import { prisma } from '../lib/prisma.js';


const TEST_PREFIX = 'QALOADTEST_';

async function seed(count: number) {
    console.log(`🌱 Seeding ${count} load-test users...`);
    const users = Array.from({ length: count }, (_, i) => ({
        telegramId: `${TEST_PREFIX}${900000000 + i}`,
        username: `qatest_${i}`,
        referralCode: `QAREF${900000000 + i}`, // Unique constraint compliant
        creditBalance: 10,
        lifetimeCredits: 10,
        vaultAddress: null,
        turnkeySubOrgId: null
    }));

    await prisma.user.createMany({ data: users as any, skipDuplicates: true });
    console.log(`✅ Seeded ${count} users with prefix ${TEST_PREFIX}`);
    console.log(`Run PM2 logs to observe parallel loop performance: pm2 logs sentry-bot | grep -i "caller"`);
}

async function cleanup() {
    console.log(`🧹 Cleaning up test users with prefix ${TEST_PREFIX}...`);
    const result = await prisma.user.deleteMany({
        where: { telegramId: { startsWith: TEST_PREFIX } }
    });
    console.log(`✅ Removed ${result.count} test users.`);
}

const [, , cmd, arg] = process.argv;
if (cmd === 'seed') {
    seed(parseInt(arg || '300', 10)).then(() => process.exit(0));
} else if (cmd === 'cleanup') {
    cleanup().then(() => process.exit(0));
} else {
    console.log('Usage: npx tsx scripts/seed-load-test-users.ts [seed <count> | cleanup]');
    process.exit(1);
}