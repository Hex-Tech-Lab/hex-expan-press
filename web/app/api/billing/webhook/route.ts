import { createWebhookHandler } from "./handler";
import { routableVerifiers, switchedOffVerifiers } from "./verifiers";

export const runtime = "nodejs";

export const POST = createWebhookHandler(() => routableVerifiers(), () => switchedOffVerifiers());
