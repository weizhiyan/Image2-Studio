import { describe, expect, it } from 'vitest';
import { contentTypeOf, imageExtensionOf, imageSizeOf } from '../bridge/files';

describe('图片文件头尺寸解析', () => {
  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864"></svg>', { width: 1536, height: 864 }],
    ['\uFEFF<?xml version="1.0"?><!--生成图--><svg viewBox="0 0 1920 1080"></svg>', { width: 1920, height: 1080 }],
    ["<svg width='640px' viewBox='0, 0, 16, 9'></svg>", { width: 640, height: 360 }],
    ['<svg height="300" viewBox="0 0 16 9"></svg>', { width: 533, height: 300 }],
    ['<svg width="100%" height="100%" viewBox="0 0 800 600"></svg>', { width: 800, height: 600 }],
    ['<svg width="1in" height="72pt"></svg>', { width: 96, height: 96 }],
    ['<svg width="0" height="10"></svg>', null],
    ['<svg data-width="400" height="10"></svg>', null],
    ['<svg viewBox="0 0 NaN 10"></svg>', null],
    ['<html><svg width="10" height="10"></svg></html>', null],
  ])('读取 SVG 实际尺寸：%s', (source, expected) => {
    expect(imageSizeOf(Buffer.from(source))).toEqual(expected);
  });

  it('按文件内容识别 GIF / SVG，正确提供媒体类型', () => {
    expect(imageExtensionOf(Buffer.from('GIF89a'), 'png')).toBe('gif');
    expect(imageExtensionOf(Buffer.from('<svg viewBox="0 0 20 20"/>'), 'png')).toBe('svg');
    expect(imageExtensionOf(Buffer.from('<html><svg /></html>'))).toBe('png');
    expect(contentTypeOf('image.svg')).toBe('image/svg+xml');
    expect(contentTypeOf('image.gif')).toBe('image/gif');
  });

  it('读取 PNG 的真实像素宽高', () => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(1024, 16);
    buffer.writeUInt32BE(1536, 20);
    expect(imageSizeOf(buffer)).toEqual({ width: 1024, height: 1536 });
  });

  it('读取 GIF 的逻辑屏幕尺寸', () => {
    const buffer = Buffer.alloc(10);
    buffer.write('GIF89a', 0, 'ascii');
    buffer.writeUInt16LE(640, 6);
    buffer.writeUInt16LE(480, 8);
    expect(imageSizeOf(buffer)).toEqual({ width: 640, height: 480 });
  });

  it('读取 JPEG 的 SOF 段尺寸', () => {
    const buffer = Buffer.alloc(32);
    buffer.set([0xff, 0xd8, 0xff, 0xc0], 0);
    buffer.writeUInt16BE(17, 4);
    buffer[6] = 8;
    buffer.writeUInt16BE(1024, 7);
    buffer.writeUInt16BE(1536, 9);
    expect(imageSizeOf(buffer)).toEqual({ width: 1536, height: 1024 });
  });

  it('读取 WebP VP8X 扩展帧尺寸', () => {
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0, 'ascii');
    buffer.write('WEBP', 8, 'ascii');
    buffer.write('VP8X', 12, 'ascii');
    buffer.writeUIntLE(1023, 24, 3);
    buffer.writeUIntLE(1535, 27, 3);
    expect(imageSizeOf(buffer)).toEqual({ width: 1024, height: 1536 });
  });

  it('不是图片或尺寸为零时返回 null', () => {
    expect(imageSizeOf(Buffer.from('not an image'))).toBeNull();
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    expect(imageSizeOf(png)).toBeNull();
  });
});
