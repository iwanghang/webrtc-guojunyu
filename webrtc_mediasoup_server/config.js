// mediasoup配置文件

const os = require('os');

module.exports = {

	//domain : process.env.DOMAIN || 'localhost',		//侦听主机名（仅用于'gulp live'任务）
	https : {
		listenIp   : '0.0.0.0',
		listenPort : 4443,
		tls        : {
			cert : `${__dirname}/certs/www.iaiia.site_bundle.pem`,
			key  : `${__dirname}/certs/www.iaiia.site.key`
		},
	},
	wss : {
		address   : 'wss://ceic.jialianiot.com:8286',
		username  : 'servertest',
		password  : '123456'
	},
	
	mediasoup :
	{
		numWorkers     : Object.keys(os.cpus()).length,		//获取cup核数，据此创建worker
		workerSettings : {
			logLevel : 'debug',
			logTags  :
			[
				'info',
				'ice',
				'dtls',
				'rtp',
				'srtp',
				'rtcp',
				'rtx',
				'bwe',
				'score',
				'simulcast',
				'svc',
				'sctp'
			],
			rtcMinPort : 40000,
			rtcMaxPort : 49999
		},
		// mediasoup Router 参数.
		routerOptions :
		{
			mediaCodecs: [
				{
				  kind: 'audio',
				  mimeType: 'audio/opus',
				  clockRate: 48000,
				  channels: 2
				},
				{
				  kind: 'video',
				  mimeType: 'video/VP8',
				  clockRate: 90000,
				  parameters: {
					'x-google-start-bitrate': 1000
				  }
				},
				{
				  kind: 'video',
				  mimeType: 'video/VP9',
				  clockRate: 90000,
				  parameters: {
					'profile-id': 2,
					'x-google-start-bitrate': 1000
				  }
				},
				{
				  kind: 'video',
				  mimeType: 'video/H264',
				  clockRate: 90000,
				  parameters: {
					'packetization-mode': 1,
					'profile-level-id': '4d0032',
					'level-asymmetry-allowed': 1,
					'x-google-start-bitrate': 1000
				  }
				},
			  ]
		},
		// mediasoup WebRtcTransport 传输选项
		webRtcTransportOptions :
		{
			listenIps :
			[
				{
					ip          : '172.29.245.41',
					announcedIp : '8.136.231.233'
				}
			],
			//initialAvailableOutgoingBitrate : 600000,
			//maxSctpMessageSize              : 262144,
			enableUdp: true,
    		enableTcp: true,
    		preferUdp: true,
			maxIncomingBitrate              : 1500000	//不是WebRtcTransport参数，最大输入比特率
		},
		// mediasoup PlainTransport 传输选项
		plainTransportOptions :
		{
			listenIp :
			{
				ip          : '172.29.245.41',
				announcedIp : '8.136.231.233'
			},
			rtcpMux: true,
    		comedia: false,
			//maxSctpMessageSize : 262144
		}
	}
};
