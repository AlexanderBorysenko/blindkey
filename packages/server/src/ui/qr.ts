import QRCode from 'qrcode';

/** An inline SVG data URI of the otpauth QR code (img-src allows `data:`). */
export async function qrDataUri(otpauthUri: string): Promise<string> {
  const svg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
