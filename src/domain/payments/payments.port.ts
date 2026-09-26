export interface WebhookValidationResult<T = WebhookEvent> {
  isValid: boolean;
  providerName?: string;
  event?: T;
  error?: string;
}

export type WebhookEventType = 'sale_completed' | 'refund_issued' | 'unknown';

export interface WebhookEvent {
  eventType: WebhookEventType;
  provider: string;
  saleId: string;
  productId: string;
  totalCents: number;
  currency: string;
  email: string;
  timestamp: string; // ISO
  rawPayload: any; // Keep for auditing
}

export interface CheckoutCommand {
  productId: string;
  userId: string;
  email: string;
  successUrl: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
  providerName: string;
}

export interface PaymentProviderPort {
  readonly providerName: string;
  
  /**
   * Evaluates if this provider should handle the webhook based on headers/body.
   */
  canHandleWebhook(headers: Record<string, string | string[] | undefined>, body: string): boolean;
  
  /**
   * Validates the cryptographic signature and parses the payload into a strictly typed event.
   * Enforces the contract using Zod schemas internally.
   */
  parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookValidationResult>;

  /**
   * Generates a checkout session/URL for the specific provider.
   */
  createCheckout(command: CheckoutCommand): Promise<CheckoutResult>;
}
