// Class to handle child process used for running GStreamer 类来处理用于运行GStreamer的子进程

const child_process = require('child_process');
const { EventEmitter } = require('events');
const shell = require('shelljs');

const { getCodecInfoFromRtpParameters } = require('./utils');

const Logger = require('./Logger');
const logger = new Logger();

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './files';

const GSTREAMER_DEBUG_LEVEL = process.env.GSTREAMER_DEBUG_LEVEL || 3;
const GSTREAMER_COMMAND = 'gst-launch-1.0';
const GSTREAMER_OPTIONS = '-v -e';

module.exports = class GStreamer {
  constructor (rtpParameters) {
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this._createProcess();
  }

  _createProcess () {
    // Use the commented out exe to create gstreamer dot file 使用注释掉的exe创建gstreamer点文件
    // const exe = `GST_DEBUG=${GSTREAMER_DEBUG_LEVEL} GST_DEBUG_DUMP_DOT_DIR=./dump ${GSTREAMER_COMMAND} ${GSTREAMER_OPTIONS}`;
    const exe = `GST_DEBUG=${GSTREAMER_DEBUG_LEVEL} ${GSTREAMER_COMMAND} ${GSTREAMER_OPTIONS}`;
    this._process = child_process.spawn(exe, this._commandArgs, {
      detached: false,
      shell: true
    });

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');
    }

    this._process.on('message', message =>
      logger.info('gstreamer::process::message [pid:%d, message:%o]', this._process.pid, message)
    );

    this._process.on('error', error =>
      console.error('gstreamer::process::error [pid:%d, error:%o]', this._process.pid, error)
    );

    this._process.once('close', () => {
      logger.info('gstreamer::process::close [pid:%d]', this._process.pid);
      this._observer.emit('process-close');
    });

    this._process.stderr.on('data', data =>
      logger.info('gstreamer::process::stderr::data [data:%o]', data)
    );

    this._process.stdout.on('data', data =>
      logger.info('gstreamer::process::stdout::data [data:%o]', data)
    );
  }

  kill () {
    logger.info('kill() [pid:%d]', this._process.pid);
    this._process.kill('SIGINT');
  }

  // Build the gstreamer child process args  构建gstreamer子进程args 
  get _commandArgs () {
    let commandArgs = [
      `rtpbin name=rtpbin latency=50 buffer-mode=0 sdes="application/x-rtp-source-sdes, cname=(string)${this._rtpParameters.video.rtpParameters.rtcp.cname}"`,
      '!'
    ];

    commandArgs = commandArgs.concat(this._videoArgs);
    commandArgs = commandArgs.concat(this._audioArgs);
    commandArgs = commandArgs.concat(this._sinkArgs);
    commandArgs = commandArgs.concat(this._rtcpArgs);

    return commandArgs;
  }

  get _videoArgs () {
    const { video } = this._rtpParameters;
    // Get video codec info
    const videoCodecInfo = getCodecInfoFromRtpParameters('video', video.rtpParameters);

    const VIDEO_CAPS = `application/x-rtp,media=(string)video,clock-rate=(int)${videoCodecInfo.clockRate},payload=(int)${videoCodecInfo.payloadType},encoding-name=(string)${videoCodecInfo.codecName.toUpperCase()},ssrc=(uint)${video.rtpParameters.encodings[0].ssrc}`;

    return [
      `udpsrc port=${video.remoteRtpPort} caps="${VIDEO_CAPS}"`,
      '!',
      'rtpbin.recv_rtp_sink_0 rtpbin.',
      '!',
      'queue',
      '!',
      'rtpvp8depay',
      '!',
      'mux.'
    ];
  }

  get _audioArgs() {
    const { audio } = this._rtpParameters;
    // Get audio codec info
    const audioCodecInfo = getCodecInfoFromRtpParameters('audio', audio.rtpParameters);

    const AUDIO_CAPS = `application/x-rtp,media=(string)audio,clock-rate=(int)${audioCodecInfo.clockRate},payload=(int)${audioCodecInfo.payloadType},encoding-name=(string)${audioCodecInfo.codecName.toUpperCase()},ssrc=(uint)${audio.rtpParameters.encodings[0].ssrc}`;

    return [
      `udpsrc port=${audio.remoteRtpPort} caps="${AUDIO_CAPS}"`,
      '!',
      'rtpbin.recv_rtp_sink_1 rtpbin.',
      '!',
      'queue',
      '!',
      'rtpopusdepay',
      '!',
      'opusdec',
      '!',
      'opusenc',
      '!',
      'mux.'
    ];
  }

  get _rtcpArgs () {
    const { video, audio } = this._rtpParameters;

    return [
      `udpsrc address=127.0.0.1 port=${video.remoteRtcpPort}`,
      '!',
      'rtpbin.recv_rtcp_sink_0 rtpbin.send_rtcp_src_0',
      '!',
      `udpsink host=127.0.0.1 port=${video.localRtcpPort} bind-address=127.0.0.1 bind-port=${video.remoteRtcpPort} sync=false async=false`,
      `udpsrc address=127.0.0.1 port=${audio.remoteRtcpPort}`,
      '!',
      'rtpbin.recv_rtcp_sink_1 rtpbin.send_rtcp_src_1',
      '!',
      `udpsink host=127.0.0.1 port=${audio.localRtcpPort} bind-address=127.0.0.1 bind-port=${audio.remoteRtcpPort} sync=false async=false`
    ];
  }

  get _sinkArgs () {
    return [
      'webmmux name=mux',
      '!',
      `filesink location=${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
    ];
  }
}
