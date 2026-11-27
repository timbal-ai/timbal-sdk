import { test, expect, describe } from 'bun:test';
import { agentReadableFileName } from '../channels/attachments';

describe('agentReadableFileName', () => {
  test('keeps names with a supported binary extension, in any case', () => {
    expect(agentReadableFileName('photo.JPG', 'image/jpeg')).toBe('photo.JPG');
    expect(agentReadableFileName('scan.pdf', 'application/octet-stream')).toBe('scan.pdf');
    expect(agentReadableFileName('report.docx', '')).toBe('report.docx');
    expect(agentReadableFileName('sheet.xlsx', 'application/zip')).toBe('sheet.xlsx');
  });

  test('adds the extension of a supported content type', () => {
    expect(agentReadableFileName('document_1', 'application/pdf')).toBe('document_1.pdf');
    expect(agentReadableFileName('image_1', 'image/png; q=1')).toBe('image_1.png');
  });

  test('keeps text files as they are', () => {
    expect(agentReadableFileName('main.py', 'text/x-python')).toBe('main.py');
    expect(agentReadableFileName('data', 'application/json')).toBe('data');
    expect(agentReadableFileName('feed.atom', 'application/atom+xml')).toBe('feed.atom');
  });

  test('refuses binary formats agents cannot read', () => {
    expect(agentReadableFileName('deck.pptx', 'application/vnd.ms-powerpoint')).toBeNull();
    expect(agentReadableFileName('archive.zip', 'application/zip')).toBeNull();
    expect(agentReadableFileName('IMG_1.HEIC', 'image/heic')).toBeNull();
    expect(agentReadableFileName('blob', 'application/octet-stream')).toBeNull();
    expect(agentReadableFileName('noext', '')).toBeNull();
  });
});
