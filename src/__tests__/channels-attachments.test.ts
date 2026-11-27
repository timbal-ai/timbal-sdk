import { test, expect, describe } from 'bun:test';
import { agentReadableUpload } from '../channels/attachments';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('agentReadableUpload', () => {
  test('keeps names with a supported binary extension, with their standard type', () => {
    expect(agentReadableUpload('photo.jpg', 'image/jpeg')).toEqual({
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
    });
    expect(agentReadableUpload('scan.pdf', 'application/octet-stream')).toEqual({
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
    });
    expect(agentReadableUpload('report.docx', '')).toEqual({
      fileName: 'report.docx',
      contentType: DOCX,
    });
    expect(agentReadableUpload('sheet.xlsx', 'application/zip')).toEqual({
      fileName: 'sheet.xlsx',
      contentType: XLSX,
    });
  });

  // The framework matches .docx/.xlsx/.eml case-sensitively: an uppercase
  // extension would be decoded as text (zip bytes) instead.
  test('lowercases the extension', () => {
    expect(agentReadableUpload('Report.DOCX', DOCX)).toEqual({
      fileName: 'Report.docx',
      contentType: DOCX,
    });
    expect(agentReadableUpload('Q3.Sheet.XLSX', XLSX)?.fileName).toBe('Q3.Sheet.xlsx');
    expect(agentReadableUpload('IMG_1.JPG', 'image/jpeg')?.fileName).toBe('IMG_1.jpg');
    expect(agentReadableUpload('Mail.EML', 'message/rfc822')?.fileName).toBe('Mail.eml');
  });

  // The type the file is served with decides images and PDFs, and the model
  // APIs reject `image/jpg`.
  test('uploads non-standard spellings of supported types under the standard one', () => {
    expect(agentReadableUpload('photo.jpg', 'image/jpg')?.contentType).toBe('image/jpeg');
    expect(agentReadableUpload('photo.jpg', 'IMAGE/PJPEG')?.contentType).toBe('image/jpeg');
    expect(agentReadableUpload('scan.pdf', 'application/x-pdf')?.contentType).toBe(
      'application/pdf',
    );
    expect(agentReadableUpload('image_1', 'image/jpg')).toEqual({
      fileName: 'image_1.jpg',
      contentType: 'image/jpeg',
    });
  });

  test('keeps a declared supported type that differs from the extension', () => {
    expect(agentReadableUpload('photo.jpg', 'image/png')?.contentType).toBe('image/png');
  });

  test('adds the extension of a supported content type', () => {
    expect(agentReadableUpload('document_1', 'application/pdf')).toEqual({
      fileName: 'document_1.pdf',
      contentType: 'application/pdf',
    });
    expect(agentReadableUpload('image_1', 'image/png; q=1')).toEqual({
      fileName: 'image_1.png',
      contentType: 'image/png',
    });
  });

  test('keeps text files as they are', () => {
    expect(agentReadableUpload('main.py', 'text/x-python')).toEqual({
      fileName: 'main.py',
      contentType: 'text/x-python',
    });
    expect(agentReadableUpload('data', 'application/json')?.fileName).toBe('data');
    expect(agentReadableUpload('feed.atom', 'application/atom+xml')?.fileName).toBe('feed.atom');
    expect(agentReadableUpload('app', 'application/javascript')?.fileName).toBe('app');
    expect(agentReadableUpload('config', 'application/x-yaml')?.fileName).toBe('config');
  });

  test('keeps text files by extension when the type is generic', () => {
    for (const name of ['notes.txt', 'README.md', 'main.py', 'app.js', 'x.json']) {
      expect(agentReadableUpload(name, 'application/octet-stream')).toEqual({
        fileName: name,
        contentType: 'application/octet-stream',
      });
    }
    expect(agentReadableUpload('data.CSV', 'application/octet-stream')?.fileName).toBe('data.csv');
  });

  test('refuses images the model APIs do not accept', () => {
    expect(agentReadableUpload('scan.bmp', 'image/bmp')).toBeNull();
    expect(agentReadableUpload('scan.tiff', 'image/tiff')).toBeNull();
  });

  test('refuses binary formats agents cannot read', () => {
    expect(agentReadableUpload('deck.pptx', 'application/vnd.ms-powerpoint')).toBeNull();
    expect(agentReadableUpload('archive.zip', 'application/zip')).toBeNull();
    expect(agentReadableUpload('IMG_1.HEIC', 'image/heic')).toBeNull();
    expect(agentReadableUpload('blob', 'application/octet-stream')).toBeNull();
    expect(agentReadableUpload('noext', '')).toBeNull();
  });
});
