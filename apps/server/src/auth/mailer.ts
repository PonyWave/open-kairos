import { createTransport, type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class SmtpEmailSender implements EmailSender {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(configuration: { url: string; from: string }) {
    this.#transport = createTransport(configuration.url);
    this.#from = configuration.from;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({ from: this.#from, ...message });
  }
}
