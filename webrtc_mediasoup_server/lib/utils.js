const { Readable } = require('stream');

// Converts a string (SDP) to a stream so it can be piped into the FFmpeg process 将字符串（SDP）转换为流，以便可以通过管道将其传输到FFmpeg进程
module.exports.convertStringToStream = (stringToConvert) => {
  const stream = new Readable();
  stream._read = () => {};
  stream.push(stringToConvert);
  stream.push(null);

  return stream;
};

// Gets codec information from rtpParameters 从rtpParameters获取编解码器信息
module.exports.getCodecInfoFromRtpParameters = (kind, rtpParameters) => {
  return {
    payloadType: rtpParameters.codecs[0].payloadType,
    codecName: rtpParameters.codecs[0].mimeType.replace(`${kind}/`, ''),
    clockRate: rtpParameters.codecs[0].clockRate,
    channels: kind === 'audio' ? rtpParameters.codecs[0].channels : undefined
  };
};
