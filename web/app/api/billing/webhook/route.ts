import { createWebhookHandler } from "./handler";
import { routableVerifiers } from "./verifiers";

export const runtime = "nodejs";

export const POST = createWebhookHandler(() => routableVerifiers());
