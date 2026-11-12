import { describe, expect, it } from 'vitest';
import { imageSizeOf } from '../bridge/files';

describe('图片文件头尺寸解析', () => {
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
