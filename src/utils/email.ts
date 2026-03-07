import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

let transporter: nodemailer.Transporter | null = null;

const getTransporter = () => {
  if (transporter) return transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.error('[Email] SMTP_USER or SMTP_PASS is missing in environment variables.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });

  return transporter;
};

export const sendEmail = async (to: string, subject: string, text: string, html?: string) => {
  try {
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
      throw new Error('Email transporter not configured. Please set SMTP_USER and SMTP_PASS in .env');
    }

    const info = await mailTransporter.sendMail({
      from: `"Afwin" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    console.log('[Email] Sent successfully: %s', info.messageId);
    return true;
  } catch (error) {
    console.error('[Email] Error sending email:', error);
    return false;
  }
};
