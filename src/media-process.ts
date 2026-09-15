/**
 * ffmpeg input is untrusted even when downloaded to a local file. Prevent
 * network protocols and playlist/image-sequence demuxers from opening secondary
 * resources. This is defense in depth, not an OS-level codec sandbox.
 * Keep these input options before -i in every ffmpeg invocation.
 */
export const LOCAL_MEDIA_INPUT_ARGS: readonly string[] = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,matroska,webm,ogg,mp3,wav,flac,aac,amr,aiff,au,avi,asf,flv,mpeg,mpegts,h264,hevc,ac3,eac3,gif",
];
