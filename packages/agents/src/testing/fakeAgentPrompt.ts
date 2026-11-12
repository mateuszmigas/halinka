import type { FakeTurn } from "./fakeAcpAgent";

// Each prompt runs the next turn. A prompt with this line starts the script again.
export const fakeAgentPrompt = (turns: FakeTurn[]) => `fake-agent: ${JSON.stringify(turns)}`;
