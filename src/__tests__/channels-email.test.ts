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

  test('reads the real href, past data-href and quoted >', () => {
    const html = (body: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body])).text;
    for (const anchor of [
      '<a data-href="https://example.org/old" href="https://example.org/join">Join</a>',
      '<a title="Orders > 10" href="https://example.org/join">Join</a>',
      "<a title='a > b' href=https://example.org/join>Join</a>",
    ]) {
      expect(html(anchor)).toBe('Subject: x\n\nJoin (https://example.org/join)');
    }
  });

  test('keeps the body when </head> is left out', () => {
    const text = parseEmail(
      crlf([
        'Subject: x',
        'Content-Type: text/html',
        '',
        '<head><title>Shipping</title><body><p>Your order ships Friday.</p></body>',
      ]),
    ).text;
    expect(text).toContain('Your order ships Friday.');
    expect(text).not.toContain('Shipping');
  });

  test('drops comments, including the tags inside them', () => {
    const text = parseEmail(
      crlf([
        'Subject: x',
        'Content-Type: text/html',
        '',
        '<p>Price €9</p><!-- <b>Previous price €15</b> --><p>Ships Friday</p>',
      ]),
    ).text;
    expect(text).toBe('Subject: x\n\nPrice €9\nShips Friday');
    expect(text).not.toContain('€15');
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('-->');
  });

  // HTML closes `<!-->` and `<!--->` at once, and a comment also ends at `--!>`.
  test('ends comments where HTML does, so no text is swallowed', () => {
    const html = (body: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body])).text;
    expect(html('<p>a</p><!--><p>Your order shipped.</p><!-- old -->b')).toBe(
      'Subject: x\n\na\nYour order shipped.\nb',
    );
    expect(html('<p>a</p><!---><p>Your order shipped.</p>')).toBe(
      'Subject: x\n\na\nYour order shipped.',
    );
    expect(html('<p>a</p><!-- x --!><p>Your order shipped.</p>')).toBe(
      'Subject: x\n\na\nYour order shipped.',
    );
    expect(html('<p>a</p><!-- x --!><!-- y --><p>b</p><!-- z --!>c')).toBe(
      'Subject: x\n\na\nb\nc',
    );
  });

  // Template content is never shown to the recipient.
  test('skips template contents, nested ones included', () => {
    const html = (body: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body])).text;
    expect(
      html(
        '<head><title>Order</title><template id="refund"><p>Your order was refunded.</p></template></head>' +
          '<body><p>Your order shipped.</p></body>',
      ),
    ).toBe('Subject: x\n\nYour order shipped.');
    expect(
      html('<p>a</p><template><template><p>x</p></template><p>y</p></template><p>after</p>'),
    ).toBe('Subject: x\n\na\nafter');
    expect(html('<p>a</p><Template >hidden</TEMPLATE><p>b</p>')).toBe('Subject: x\n\na\nb');
    expect(html('<p>a</p><template><p>never closed')).toBe('Subject: x\n\na');
    // `<templates>` is another element.
    expect(html('<templates>shown</templates>')).toBe('Subject: x\n\nshown');
  });

  // Only real template tags count: one inside a comment, a quoted attribute
  // or a script must neither leak hidden text nor hide visible text.
  test('counts only real template tags', () => {
    const body = (html: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', html])).text;
    for (const html of [
      '<template><!-- One <template> per language. --></template><p>Shipped.</p>',
      '<template><!-- Insert before </template> --><p>Refunded.</p></template><p>Shipped.</p>',
      '<template><p title="</template>">Refunded.</p></template><p>Shipped.</p>',
      "<template><p title='<template>'>Refunded.</p></template><p>Shipped.</p>",
      '<template><script>s = "</template>"</script><p>Refunded.</p></template><p>Shipped.</p>',
      '<template><style>/* </template> */</style><p>Refunded.</p></template><p>Shipped.</p>',
      '<template><a href="https://hidden.example">Refunded.</a></template><p>Shipped.</p>',
    ]) {
      expect(body(html)).toBe('Subject: x\n\nShipped.');
    }
    // A stray end tag outside any template changes nothing.
    expect(body('<p>a</p></template><p>b</p>')).toBe('Subject: x\n\na\nb');
  });

  // As in browsers: `</styles-x>` or a `"</scripted"` string doesn't end them.
  test('ends a script or style only at its own end tag', () => {
    const html = (body: string) =>
      parseEmail(crlf(['Subject: x', 'Content-Type: text/html', '', body])).text;
    expect(html('<style>p{}</styles-x>.c{color:red}</style><p>shown</p>')).toBe(
      'Subject: x\n\nshown',
    );
    expect(html('<p>a</p><script>s = "</scripted>"; hidden()</script><p>b</p>')).toBe(
      'Subject: x\n\na\nb',
    );
    expect(html('<p>a</p><STYLE>x</Style >y</STYLE>')).toBe('Subject: x\n\na\ny');
  });

  // Lowercasing can lengthen a string (İ → i̇), so positions must come from
  // the original text.
  test('finds end tags after text that lowercases to a different length', () => {
    const text = parseEmail(
      crlf(['Subject: x', 'Content-Type: text/html', '', `<p>${'İ'.repeat(40)}</p><style>x</style><p>after</p>`]),
    ).text;
    expect(text).toBe(`Subject: x\n\n${'İ'.repeat(40)}\nafter`);
  });

  // The regex version took 20-35 s on ~200-400 KB of these, blocking the server.
  test('converts crafted HTML in linear time', () => {
    const crafted = [
      '<style>'.repeat(50_000),
      '<a href="https://x">'.repeat(50_000),
      '<'.repeat(1_000_000),
      `<p>${' '.repeat(1_000_000)}x</p>`,
      '<title>'.repeat(50_000),
      '<a x="'.repeat(50_000),
      '<!--'.repeat(100_000),
      '<!'.repeat(100_000),
      '</'.repeat(100_000) + '<script>',
      '<template>'.repeat(100_000),
      '<template>'.repeat(50_000) + '</template>'.repeat(50_000),
      '<!-- x -->'.repeat(100_000) + '--!>',
      '<!-- x --!>'.repeat(100_000),
      '<!-- x --!>'.repeat(100_000) + '-->',
      '<!-->'.repeat(200_000),
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

  test('keeps two different inline images that share a name, type and size', () => {
    const gif = (bytes: string) => Buffer.from(bytes).toString('base64');
    const image = (cid: string, bytes: string) => [
      'Content-Type: image/gif; name="chart.gif"',
      `Content-ID: <${cid}>`,
      'Content-Transfer-Encoding: base64',
      '',
      gif(bytes),
    ];
    const email = (images: string[][]) =>
      parseEmail(
        crlf([
          'Subject: Charts',
          'Content-Type: multipart/alternative; boundary=a',
          '',
          '--a',
          'Content-Type: text/plain',
          '',
          'charts',
          '--a',
          'Content-Type: multipart/related; boundary=r',
          '',
          '--r',
          'Content-Type: text/html',
          '',
          '<img src="cid:c1"><img src="cid:c2">',
          ...images.flatMap((lines) => ['--r', ...lines]),
          '--r--',
          '--a',
          'Content-Type: multipart/related; boundary=s',
          '',
          '--s',
          'Content-Type: text/html',
          '',
          '<p>charts, again</p><img src="cid:c1">',
          '--s',
          ...image('c1', 'GIF89aAAAA'),
          '--s--',
          '--a--',
        ]),
      );

    const bytesOf = (e: ReturnType<typeof parseEmail>) =>
      e.attachments.map((a) => new TextDecoder().decode(a.data));

    // c1 also appears in the last version: that identical copy is kept once.
    expect(bytesOf(email([image('c1', 'GIF89aAAAA'), image('c2', 'GIF89aBBBB')]))).toEqual([
      'GIF89aAAAA',
      'GIF89aBBBB',
    ]);
    // Only the identical copy across the two HTML versions: one file.
    expect(bytesOf(email([image('c1', 'GIF89aAAAA')]))).toEqual(['GIF89aAAAA']);
  });

  test('reads a digest entry without Content-Type as an email', () => {
    const pdf = Buffer.from('%PDF-1.4 report').toString('base64');
    const digest = parseEmail(
      crlf([
        'Subject: Digest',
        'Content-Type: multipart/digest; boundary=d',
        '',
        '--d',
        '',
        'Subject: inner',
        'Content-Type: multipart/mixed; boundary=m',
        '',
        '--m',
        'Content-Type: text/plain',
        '',
        'inner body',
        '--m',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="report.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        pdf,
        '--m--',
        '--d--',
      ]),
    );
    expect(digest.text).not.toContain(pdf);
    expect(digest.attachments.map((a) => [a.fileName, a.contentType])).toEqual([
      ['forwarded-1.eml', 'message/rfc822'],
    ]);
    const inner = parseEmail(digest.attachments[0]!.data);
    expect(inner.text).toBe('Subject: inner\nAttachments: report.pdf\n\ninner body');
    expect(new TextDecoder().decode(inner.attachments[0]!.data)).toBe('%PDF-1.4 report');
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
