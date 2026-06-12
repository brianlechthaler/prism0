export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailSender = (message: EmailMessage) => Promise<void>;

export type EmailServiceOptions = {
  mode: "console";
};

export function createEmailSender(_options: EmailServiceOptions): EmailSender {
  return async (message) => {
    console.log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
  };
}

export function buildVerificationEmail(appBaseUrl: string, token: string): Pick<EmailMessage, "subject" | "text"> {
  const url = `${appBaseUrl.replace(/\/$/, "")}/verify-email#token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your prism0 account",
    text: `Welcome to prism0! Verify your email by visiting:\n\n${url}\n\nThis link expires in 24 hours.`
  };
}
