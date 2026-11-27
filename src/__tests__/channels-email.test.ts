import { test, expect, describe } from 'bun:test';
import { parseEmail } from '../channels/email';

const crlf = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n'));
const PDF = new TextEncoder().encode('%PDF-1.4 fake invoice');

describe('parseEmail', () => {
  test('splits a multipart email into its text and decoded attachments', () => {
    const email = parseEmail(
      crlf([
        'From: Ana <ana@example.com>',
        'To: bob@example.com',
        'Subject: Invoice',
        'Date: Fri, 27 Nov 2026 09:00:00 +0100',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        'This is a multi-part message in MIME format.',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please find the invoice attached.',
        '--b1',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(PDF).toString('base64'),
        '--b1--',
        '',
      ]),
    );

    expect(email.text).toBe(
      [
        'From: Ana <ana@example.com>',
        'To: bob@example.com',
        'Date: Fri, 27 Nov 2026 09:00:00 +0100',
        'Subject: Invoice',
        'Attachments: invoice.pdf',
        '',
        'Please find the invoice attached.',
      ].join('\n'),
    );
    expect(email.text).not.toContain('JVBER'); // no base64 in the text
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]!.fileName).toBe('invoice.pdf');
    expect(email.attachments[0]!.contentType).toBe('application/pdf');
    expect(email.attachments[0]!.data).toEqual(PDF);
  });

  test('prefers plain text in multipart/alternative and reads HTML when it is all there is', () => {
    const alternative = parseEmail(
      crlf([
        'Subject: Hi',
        'Content-Type: multipart/alternative; boundary=alt',
        '',
        '--alt',
        'Content-Type: text/plain',
        '',
        'plain body',
        '--alt',
        'Content-Type: text/html',
        '',
        '<p>html body</p>',
        '--alt--',
      ]),
    );
    expect(alternative.text).toBe('Subject: Hi\n\nplain body');

    const html = parseEmail(
      crlf([
        'Subject: Hi',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><head><style>p{color:red}</style></head>',
        '<body><p>Hello&nbsp;<b>there</b> &amp; welcome</p><p>Line&#33;</p></body></html>',
      ]),
    );
    expect(html.text).toBe('Subject: Hi\n\nHello there & welcome\nLine!');
  });

  test('decodes quoted-printable bodies in their charset', () => {
    const email = parseEmail(
      crlf([
        'Subject: Caf=?iso-8859-1?q?=E9?=',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Un caf=E9 tr=E8s long qui continue sur =',
        'la ligne suivante.',
      ]),
    );
    expect(email.text).toBe('Subject: Café\n\nUn café très long qui continue sur la ligne suivante.');
  });

  test('decodes encoded words, RFC 2231 file names and raw UTF-8 headers', () => {
    const email = parseEmail(
      crlf([
        'Subject: =?UTF-8?B?UmVzdW1lbiDDqXTDqQ==?= =?UTF-8?Q?_y_m=C3=A1s?=',
        'From: José <jose@example.com>',
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        'body',
        '--b',
        'Content-Type: application/pdf',
        "Content-Disposition: attachment; filename*0*=UTF-8''%E2%82%AC%20; filename*1=\"report.pdf\"",
        '',
        '%PDF',
        '--b',
        'Content-Type: image/png; name="=?UTF-8?B?w7Fhbmku?= =?UTF-8?B?cG5n?="',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--b--',
      ]),
    );
    expect(email.text).toContain('Subject: Resumen été y más');
    expect(email.text).toContain('From: José <jose@example.com>');
    expect(email.attachments.map((a) => a.fileName)).toEqual(['€ report.pdf', 'ñani.png']);
  });

  test('keeps a forwarded email and unnamed parts as attachments', () => {
    const email = parseEmail(
      crlf([
        'Subject: Fwd',
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: text/plain',
        '',
        'see below',
        '--b',
        'Content-Type: message/rfc822',
        '',
        'Subject: original',
        '',
        'original body',
        '--b',
        'Content-Type: image/png',
        'Content-ID: <logo>',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--b--',
      ]),
    );
    expect(email.attachments.map((a) => [a.fileName, a.contentType])).toEqual([
      ['forwarded-1.eml', 'message/rfc822'],
      ['attachment-2', 'image/png'],
    ]);
    expect(new TextDecoder().decode(email.attachments[0]!.data)).toContain('original body');
  });

  test('returns input without email headers as text', () => {
    const email = parseEmail(new TextEncoder().encode('just some notes\nnothing else'));
    expect(email).toEqual({ text: 'just some notes\nnothing else', attachments: [] });
  });

  test('handles LF-only line endings', () => {
    const email = parseEmail(
      new TextEncoder().encode(
        'Subject: lf\nContent-Type: multipart/mixed; boundary=x\n\n--x\nContent-Type: text/plain\n\nhello\n--x--\n',
      ),
    );
    expect(email.text).toBe('Subject: lf\n\nhello');
  });
});
