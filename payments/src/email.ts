import { Resend } from "resend";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail({ to, subject, html, text }: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is missing — cannot send email");
  }
  const from = process.env.EMAIL_FROM || "ExpanPress <onboarding@resend.dev>";

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    ...(text !== undefined ? { text } : {}),
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
  return { id: data.id };
}
