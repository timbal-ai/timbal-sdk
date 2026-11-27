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

  test('takes the alternative that has text, and keeps inline files from every version', () => {
    const related = (html: string) => [
      'Content-Type: multipart/related; boundary=r',
      '',
      '--r',
      'Content-Type: text/html',
      '',
      html,
      '--r',
      'Content-Type: image/png',
      'Content-ID: <shot>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--r--',
    ];
    const alternative = (plain: string, html: string) =>
      parseEmail(
        crlf([
          'Subject: Appt',
          'Content-Type: multipart/alternative; boundary=a',
          '',
          '--a',
          'Content-Type: text/plain',
          '',
          plain,
          '--a',
          ...related(html),
          '--a--',
        ]),
      );

    const emptyPlain = alternative('', '<p>Dentist Tuesday 10:00</p><img src="cid:shot">');
    expect(emptyPlain.text).toBe('Subject: Appt\nAttachments: attachment-1\n\nDentist Tuesday 10:00');
    expect(emptyPlain.attachments.map((a) => a.contentType)).toEqual(['image/png']);

    const seeScreenshot = alternative('see screenshot', '<p>see <img src="cid:shot"></p>');
    expect(seeScreenshot.text).toBe('Subject: Appt\nAttachments: attachment-1\n\nsee screenshot');
    expect(seeScreenshot.attachments.map((a) => a.contentType)).toEqual(['image/png']);
  });

  test('keeps the sections of a multipart/mixed email in order', () => {
    const email = parseEmail(
      crlf([
        'Subject: Update',
        'Content-Type: multipart/mixed; boundary=m',
        '',
        '--m',
        'Content-Type: text/plain',
        '',
        'Here is the update',
        '--m',
        'Content-Type: text/html',
        '',
        '<p>Shipment arrives Friday</p>',
        '--m--',
      ]),
    );
    expect(email.text).toBe('Subject: Update\n\nHere is the update\n\nShipment arrives Friday');
  });

  test('keeps link destinations from HTML', () => {
    const email = parseEmail(
      crlf([
        'Subject: Invite',
        'Content-Type: text/html',
        '',
        '<p><a href="https://meet.example.com/abc?x=1&amp;y=2">Join <b>meeting</b></a></p>',
        "<p><a href='mailto:ana@example.com'>ana@example.com</a></p>",
        '<p><a href="https://example.com">https://example.com</a></p>',
        '<p><a href="#top">Back to top</a> <a href="javascript:void(0)">Click</a></p>',
      ]),
    );
    expect(email.text).toBe(
      [
        'Subject: Invite',
        'Join meeting (https://meet.example.com/abc?x=1&y=2)',
        'ana@example.com',
        'https://example.com',
        'Back to top Click',
      ].join('\n\n'),
    );
  });

  test('reads malformed HTML: unclosed links and styles, stray <', () => {
    const html = (body: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body])).text;
    expect(html('<a href="https://a.example">first <a href="https://b.example">second')).toBe(
      'Subject: x\n\nfirst (https://a.example) second (https://b.example)',
    );
    expect(html('<p>kept</p><style>p { color: red }')).toBe('Subject: x\n\nkept');
    expect(html('1 < 2 and 3 &lt; 4')).toBe('Subject: x\n\n1 < 2 and 3 < 4');
    expect(html('<!-- note --><!DOCTYPE html>text')).toBe('Subject: x\n\ntext');
  });

  // The regex version took 20-35 s on ~200-400 KB of these, blocking the server.
  test('converts crafted HTML in linear time', () => {
    const crafted = [
      '<style>'.repeat(50_000),
      '<a href="https://x">'.repeat(50_000),
      '<'.repeat(1_000_000),
      `<p>${' '.repeat(1_000_000)}x</p>`,
    ];
    for (const body of crafted) {
      const started = Date.now();
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body]));
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  test('reads a part that has no headers', () => {
    const email = parseEmail(
      crlf(['Subject: Note', 'Content-Type: multipart/mixed; boundary=m', '', '--m', '', 'Please arrive by noon', '--m--']),
    );
    expect(email.text).toBe('Subject: Note\n\nPlease arrive by noon');
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
