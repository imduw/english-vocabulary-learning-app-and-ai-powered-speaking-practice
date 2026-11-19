import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { ApiError } from '../common/api-error';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export interface OcrUpload { buffer: Buffer; mimetype: string }
export interface OcrImage {
  buffer: Buffer; width: number; height: number; processed_width: number; processed_height: number;
}
@Injectable()
export class OcrImageProcessor {
  async prepare(file: OcrUpload): Promise<OcrImage> {
    const bytes = file.buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(400,'INVALID_IMAGE','Image is empty or invalid');
    if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError(413,'IMAGE_TOO_LARGE','Image must not exceed 10 MiB');
    // Reject non-raster formats before invoking any decoder, regardless of MIME/filename.
    const format = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
      : bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ? 'jpeg'
      : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' ? 'webp' : undefined;
    if (!format || file.mimetype !== `image/${format}`) throw new ApiError(400,'UNSUPPORTED_IMAGE','Image bytes and MIME must agree: JPEG, PNG or WebP');
    try {
      const input = sharp(bytes,{limitInputPixels:16000000,failOn:'warning'});
      const meta = await input.metadata();
      if (meta.format!==format || !meta.width || !meta.height || (meta.pages??1)!==1 || meta.width*meta.height>16000000) throw new Error('Unsupported image geometry');
      const swap = [5,6,7,8].includes(meta.orientation??1);
      const width = swap ? meta.height : meta.width, height = swap ? meta.width : meta.height;
      const {data,info} = await input.autoOrient().resize({width:1800,height:2400,fit:'inside',withoutEnlargement:true})
        .flatten({background:'#ffffff'}).grayscale().normalise().sharpen({sigma:1})
        .png({compressionLevel:1}).timeout({seconds:5}).toBuffer({resolveWithObject:true});
      return {buffer:data,width,height,processed_width:info.width,processed_height:info.height};
    } catch {
      throw new ApiError(400,'INVALID_IMAGE','Image cannot be decoded, is animated, or exceeds the 16 megapixel limit');
    }
  }
}
