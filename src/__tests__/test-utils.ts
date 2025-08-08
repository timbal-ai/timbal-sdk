import { Timbal } from "../lib/timbal";

export const shouldRunIntegrationTests = () => {
  // Skip integration tests if explicitly requested
  if (process.env.SKIP_INTEGRATION_TESTS === 'true') {
    return false;
  }
  
  return !!(
    process.env.TIMBAL_API_KEY && 
    process.env.TIMBAL_ORG_ID && 
    process.env.TIMBAL_KB_ID
  );
};

export const createTestTimbal = (): Timbal => {
  if (!shouldRunIntegrationTests()) {
    throw new Error("Cannot create test Timbal instance - missing environment variables");
  }

  const timbal = new Timbal({
    apiKey: process.env.TIMBAL_API_KEY!,
    baseUrl: process.env.TIMBAL_BASE_URL || 'https://api.timbal.ai',
  });
  
  // Set defaults
  timbal.setQueryDefaults({
    orgId: process.env.TIMBAL_ORG_ID!,
    kbId: process.env.TIMBAL_KB_ID!,
  });

  timbal.setTableDefaults({
    orgId: process.env.TIMBAL_ORG_ID!,
    kbId: process.env.TIMBAL_KB_ID!,
  });

  return timbal;
};

export const logIntegrationTestConfig = () => {
  if (shouldRunIntegrationTests()) {
    console.log("🔧 Integration test config:", {
      apiKey: process.env.TIMBAL_API_KEY?.substring(0, 10) + '...',
      baseUrl: process.env.TIMBAL_BASE_URL || 'https://api.timbal.ai',
      orgId: process.env.TIMBAL_ORG_ID,
      kbId: process.env.TIMBAL_KB_ID,
    });
  } else {
    console.log("⚠️  Skipping integration tests - set TIMBAL_API_KEY, TIMBAL_ORG_ID, and TIMBAL_KB_ID environment variables to run");
  }
};