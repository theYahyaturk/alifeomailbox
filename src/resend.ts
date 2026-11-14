import type { SendEmailPayload } from './types';

export interface ResendResponse {
  id?: string;
  error?: {
    message: string;
    name: string;
    statusCode: number;
  };
}

export async function sendEmailViaResend(
  payload: SendEmailPayload,
  apiKey: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const formattedFrom = payload.from_name
      ? `${payload.from_name} <${payload.from}>`
      : payload.from;

    const toList = Array.isArray(payload.to) ? payload.to : [payload.to];
    const ccList = payload.cc ? (Array.isArray(payload.cc) ? payload.cc : [payload.cc]) : undefined;
    const bccList = payload.bcc ? (Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc]) : undefined;

    const body: Record<string, any> = {
      from: formattedFrom,
      to: toList,
      subject: payload.subject,
    };

    if (ccList && ccList.length > 0) body.cc = ccList;
    if (bccList && bccList.length > 0) body.bcc = bccList;
    if (payload.reply_to) body.reply_to = payload.reply_to;
    if (payload.html) body.html = payload.html;
    if (payload.text) body.text = payload.text;

    // Attachments for Resend API
    if (payload.attachments && payload.attachments.length > 0) {
      body.attachments = payload.attachments.map(att => ({
        filename: att.filename,
        content: att.content // Base64 string
      }));
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = (await response.json()) as ResendResponse;

    if (!response.ok || data.error) {
      return {
        success: false,
        error: data.error?.message || `Resend API returned status ${response.status}`
      };
    }

    return {
      success: true,
      messageId: data.id
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Network error sending email via Resend'
    };
  }
}

