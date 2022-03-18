const EventEmitter = require('events').EventEmitter;
//const throttle = require('@sitespeed.io/throttle');
const config = require('../config');

const Peer = require('./peer');
const FFmpeg = require('./ffmpeg');
const GStreamer = require('./gstreamer');
const {
	getPort,
	releasePort
} = require('./port');
const PROCESS_NAME = process.env.PROCESS_NAME || 'FFmpeg';



class Room extends EventEmitter
{
	// 创建并返回房间实例的工厂函数
	static async create({ mediasoupWorker, roomId })
	{
		console.log('create() [roomId:%s]', roomId);
		
		const { mediaCodecs } = config.mediasoup.routerOptions;		// 设置媒体编码
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });	// 创建Router		
		/*const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver({		// 音频音量相关
			maxEntries : 1,
			threshold  : -80,
			interval   : 800
		});*/

		return new Room({
			roomId,
			mediasoupRouter
		//	audioLevelObserver,
		});
	}

	// 构造函数
	constructor({ roomId, mediasoupRouter })
	{
		super();
		//this.setMaxListeners(Infinity);		// 改变监听器的默认限制的数量

		this._peers = new Map();
		this._roomId = roomId;
		this._mediasoupRouter = mediasoupRouter;
		//this._audioLevelObserver = audioLevelObserver;
		this._networkThrottled = false;		// 网络限制
		this._rtpInterval = 0
		//this._handleAudioLevelObserver();
		//global.audioLevelObserver = this._audioLevelObserver;	//global是一个全局对象
	}


	/*_handleAudioLevelObserver()
	{
		this._audioLevelObserver.on('volumes', (volumes) =>	{	//有音量活动
			const { producer, volume } = volumes[0];

			console.log(
				'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
				producer.id, volume);
		});

		this._audioLevelObserver.on('silence', () => {	//静音时间
			console.log('audioLevelObserver "silence" event');
		});
	}*/


	// 通过关闭proto Room和mediasoop Router来关闭Room实例。
	close()
	{
		console.log('close()');

		this._mediasoupRouter.close();
		this.emit('close');		
		clearInterval(this._rtpInterval);
		
		if (this._networkThrottled)	{
			//throttle.stop({})
			//	.catch(() => {});
		}
	}



	//加入房间	
	join({ peerId, device, rtpCapabilities, sctpCapabilities })
	{
		const peer = new Peer(peerId, this._roomId);
		peer.device = device;
		peer.rtpCapabilities = rtpCapabilities;
		peer.sctpCapabilities = sctpCapabilities;			

		this._peers.set(peerId, peer);
		return peer;
	}
	
	//离开房间	
	leave({ peerId })
	{
		let peer = this._peers.get(peerId);
		if (!peer) {
			console.log(`leave:Peer with id ${peerId} was not found`);
			return;
		}
		// 迭代并关闭所有与此对等机关联的mediasoop传输，因此其所有生产者和消费者也将被关闭
		for (const transport of peer.transports.values()) {
			transport.close();
		}

		// 关闭录制程序
		if (peer.process != undefined) {
			peer.process.kill();
			peer.process = undefined;
		}

		// 从端口集释放端口
		for (const remotePort of peer.remotePorts) {
			releasePort(remotePort);
		}

		// 如果房间没人，则关闭房间
		this._peers.delete(peerId);
		peer = null;
		//Object.keys(this._peers).length
		//console.log(Array.from(this._peers.keys()).length);
		if (Array.from(this._peers.keys()).length === 0) {
			console.log(
				'last Peer in the room left, closing the room [roomId:%s]',
				this._roomId);

			this.close();
		}
	}

	//创建消费者
	createConsumer({ socket, peerId, serverID })
	{
		const peer = this._peers.get(peerId);
		if (!peer) {
			console.log(`leave:Peer with id ${peerId} was not found`);
			return;
		}
		for (const _peer of this._peers.values()) {
			if (_peer.peerId != peer.peerId) {
				for (const producer of _peer.producers.values()){
					//const consumer = Array.from(peer.consumers.values()).find((t) => t.producerId == producer.id);
					//if(consumer == undefined){
						this._createConsumer({
							consumerPeer : peer,
							producerPeer : _peer,
							producer,
							socket,
							serverID
						});
					//}
				}
			}
		}

	}


	// 处理请求
	async getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	async createWebRtcTransport({ peerId, forceTcp, producing, consuming, sctpCapabilities })
	{
		const peer = this._peers.get(peerId);
		if (!peer) {
			throw new Error(`createWebRtcTransport:Peer with id ${peerId} was not found`);
		}
		const webRtcTransportOptions =
				{
					...config.mediasoup.webRtcTransportOptions,
					enableSctp     : Boolean(sctpCapabilities),
					numSctpStreams : (sctpCapabilities || {}).numStreams,
					appData        : { producing, consuming }
				};
		if (forceTcp)
		{
			webRtcTransportOptions.enableUdp = false;
			webRtcTransportOptions.enableTcp = true;
		}

		const transport = await this._mediasoupRouter.
			createWebRtcTransport(webRtcTransportOptions);
		peer.transports.set(transport.id, transport);
		return({
			id             : transport.id,
			iceParameters  : transport.iceParameters,
			iceCandidates  : transport.iceCandidates,
			dtlsParameters : transport.dtlsParameters,
			sctpParameters : transport.sctpParameters
		});
	}

	async connectWebRtcTransport({ peerId, transportId, dtlsParameters })
	{
		const peer = this._peers.get(peerId);
		if (!peer) {
			throw new Error(`createWebRtcTransport:Peer with id ${peerId} was not found`);
		}
		const transport = peer.transports.get(transportId);
		if (!transport)
			throw new Error(`connectWebRtcTransport:transport with id "${transportId}" not found`);

		await transport.connect({ dtlsParameters });
		return({ transportId });
	}

	async produce({ peerId, transportId, kind, rtpParameters, appData, socket, serverID, peers })
	{
		const peer = this._peers.get(peerId);
		if (!peer) {
			throw new Error(`produce:Peer with id ${peerId} was not found`);
		}
		const transport = peer.transports.get(transportId);
		if (!transport)
			throw new Error(`produce:transport with id "${transportId}" not found`);

		appData = { ...appData, peerId };
		const producer = await transport.produce(
			{
				kind,
				rtpParameters,
				appData
			});

		console.log(
			'producer "type_score" event [producerId:%s, type:%o, score:%o]',
			producer.id, producer.type, producer.score);

		// 将生产者存储到Peer数据对象中。 
		peer.producers.set(producer.id, producer);

		producer.on('transportclose', async () =>
		{
			console.log("transportclose:transport closed so producer closed");
			//this.leave({ peerId });
			//peers.delete(peerId);

			await socket.send(JSON.stringify({'type':'videos_members_break','break_id':peerId,'from_id':serverID}));	
		});

		producer.observer.on('close',async () =>
		{
			console.log("close:transport closed so producer closed");
			//this.leave({ peerId });
			//peers.delete(peerId);

			await socket.send(JSON.stringify({'type':'videos_members_break','break_id':peerId,'from_id':serverID}));	
		});

		producer.on('score', (score) =>
		{
			console.log(
				'producer "score" event [producerId:%s, score:%o]',
				producer.id, score);
		});

		producer.on('videoorientationchange', (videoOrientation) =>
		{
		});

		producer.on('trace', (trace) =>
		{
		});

		await socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
			action: 'produce',
			id: producer.id,
			kind
		}}));		

		//创造对应的消费者
		for (const _peer of this._peers.values()) {
			if (_peer.peerId != peer.peerId) {
				this._createConsumer({
					consumerPeer : _peer,
					producerPeer : peer,
					producer,
					socket,
					serverID
				});
			}
		}

		//创建ffmpeg消费者,用于保存视频
		//await this._ffmpegConsumer({ peer, producer });
		
		//执行保存视频
		// const array = Array.from(peer.producers.values());
		// const len = array.length;
		// if ( len > 1 ) {
		// 	if ( array[0].kind === 'audio' &&  array[1].kind === 'video' ) {
		// 		this._startRecord( peer );
		// 	}
		// }

		//等待2秒，执行保存视频
		// if (kind === 'video') {
		// 	setTimeout(async () => {
		// 		this._startRecord( peer );
		// 	}, 1000);
		// }
	}




	//为给定的mediasoop生产者创建mediasoop消费者	 
	async _createConsumer({ consumerPeer, producerPeer, producer, socket, serverID })
	{
		// 优化：在暂停模式下创建服务器端使用者。将其告知其对等方并等待其响应。收到响应后，恢复服务器端使用者。
		// 如果是视频，则表示服务器端使用者请求的单个关键帧（恢复时）。如果是音频（或视频），
		// 它将避免远程端点*在*在端点中本地创建使用者之前*接收RTP包（并且在本地SDP O/A过程结束之前）。
		// 如果发生这种情况（在SDP O/A完成之前接收到RTP包），PeerConnection可能无法关联RTP流。

		const temporaryConsumer = Array.from(consumerPeer.consumers.values()).find((t) => t.producerId == producer.id);
		if(temporaryConsumer != undefined){
			return;
		}

		// 注意：如果远程对等机无法使用，请不要创建使用者
		if (!consumerPeer.rtpCapabilities || !this._mediasoupRouter.canConsume({
				producerId      : producer.id,
				rtpCapabilities : consumerPeer.rtpCapabilities
			})
		)
		{
			return;
		}

		// 能接受远程对等机用于消费的传输
		const transport = Array.from(consumerPeer.transports.values())
			.find((t) => t.appData.consuming);

		if (!transport)
		{
			console.log('_createConsumer() | Transport for consuming not found');
			return;
		}

		// 在暂停模式下创建使用者
		let consumer;
		try
		{
			consumer = await transport.consume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.rtpCapabilities,
					paused          : true
				});
		}
		catch (error)
		{
			console.log('_createConsumer() | transport.consume():%o', error);
			return;
		}

		// 将使用者存储到proto consumer peer数据对象中
		consumerPeer.consumers.set(consumer.id, consumer);

		consumer.on('transportclose', () =>
		{
			consumerPeer.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			consumerPeer.consumers.delete(consumer.id);
		});

		consumer.on('producerpause', () =>
		{
			console.log('producerpause producerpause producerpause');
		});

		consumer.on('producerresume', () =>
		{
			console.log('producerresume producerresume producerresume');
		});

		consumer.on('score', (score) =>
		{
			console.log(
				'consumer "type_score" event [consumerId:%s, type:%o, score:%o, spatialLayer:%o, temporalLayer:%o]',
				consumer.id, consumer.type, consumer.score, consumer.spatialLayer, consumer.temporalLayer);
		});

		consumer.on('layerschange', (layers) =>
		{
			console.log(
				'consumer "type_layerschange" event [consumerId:%s, spatialLayer:%o, temporalLayer:%o]',
				consumer.id, layers.spatialLayer, layers.temporalLayer);
		});


		// 使用者参数向远程对等方发送proto请求
		try{
			await socket.send(JSON.stringify({'type':'re_server_data','to_id':consumerPeer.peerId,'from_id':serverID,'data':{
				action: 'newConsumer',
				peerId         : producerPeer.peerId,
				producerId     : producer.id,
				id             : consumer.id,
				kind           : consumer.kind,
				rtpParameters  : consumer.rtpParameters,
				type           : consumer.type,
				appData        : producer.appData,
				producerPaused : consumer.producerPaused
			}}));
			
			// 既然我们从远程端点得到了肯定的响应，那么恢复使用者，这样一旦远程端点的PeerConnection
			// 已经准备好处理和关联它，它就会收到这个新流的第一个RTP包
			//await consumer.resume();
		} catch (error) {
			console.log('_createConsumer() | failed:%o', error);
		}

		// setInterval(async () => {
		// 	console.log('transport.getStats:%o', await transport.getStats());
		// 	console.log('consumer.getStats:%o', await consumer.getStats());
		// }, 3000);
		
	}


	// 回调consumer使开始播放
	async consumerResume({ peerId, consumerId })
	{
		const peer = this._peers.get(peerId);
		if (!peer) {
			throw new Error(`consumerResume:Peer with id ${peerId} was not found`);
		}
		const consumer = peer.consumers.get(consumerId);
		if (!consumer)
			throw new Error(`consumerResume:consumer with id "${consumerId}" not found`);

		await consumer.resume();
	}


	async _ffmpegConsumer({ peer, producer })
	{		
		const rtpTransportConfig =
				{
					...config.mediasoup.plainTransportOptions,
					appData        : { producing:false, consuming:false }
				};
		if (PROCESS_NAME === 'GStreamer') {
			rtpTransportConfig.rtcpMux = false;
		}
		
		const rtpTransport = await this._mediasoupRouter.createPlainTransport(rtpTransportConfig);
		
		// 设置接收器RTP端口
		const remoteRtpPort = await getPort();
		peer.remotePorts.push(remoteRtpPort);
		
		// 如果RTPTTransport rtcpMux为false，还应设置接收器RTCP端口
		let remoteRtcpPort;
		if (!rtpTransportConfig.rtcpMux) {
			remoteRtcpPort = await getPort();
			peer.remotePorts.push(remoteRtcpPort);
		}
		
		// 将mediasoup RTP传输连接到GStreamer使用的端口
		await rtpTransport.connect({
			ip: '127.0.0.1',
			port: remoteRtpPort,
			rtcpPort: remoteRtcpPort
		});
		
		peer.transports.set(rtpTransport.id, rtpTransport);
		
		// 传递给RTP使用者的编解码器必须与Mediasoup路由器rtpCapabilities中的编解码器匹配
		const codecs = [];		
		const routerCodec = this._mediasoupRouter.rtpCapabilities.codecs.find(
			codec => codec.kind === producer.kind
		);
		codecs.push(routerCodec);
		
		const rtpCapabilities = {
			codecs,
			rtcpFeedback: []
		};
		
		// 启动消费者暂停, 一旦gstreamer进程准备好使用，请恢复并发送关键帧
		const rtpConsumer = await rtpTransport.consume({
			producerId: producer.id,
			rtpCapabilities,
			paused: true
		});
		
		peer.rtpconsumers.push(rtpConsumer);

		peer.recordInfo[producer.kind] = {
			remoteRtpPort,
			remoteRtcpPort,
			localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
			rtpCapabilities,
			rtpParameters: rtpConsumer.rtpParameters
		};
		//rtpConsumer.resume();
		this._rtpInterval = setInterval(async () => {
			console.log('rtpTransport.getStats:%o', await rtpTransport.getStats());
			console.log('rtpConsumer.getStats:%o', await rtpConsumer.getStats());
		}, 5000);
	}


	async _startRecord( peer )
	{
		peer.recordInfo.fileName = Date.now().toString();	//保存文件名
		console.log('recordInfo:%o', peer.recordInfo);

		//获取进程
		switch (PROCESS_NAME) {
			case 'GStreamer':
				peer.process = new GStreamer(peer.recordInfo);
				break;
			case 'FFmpeg':
				peer.process = new FFmpeg(peer.recordInfo);
				break;
			default:
				//peer.data.process = new FFmpeg(peer.data.recordInfo);
		}

		setTimeout(async () => {
			for (const consumer of peer.rtpconsumers) {
				await consumer.resume();
				console.log('Consumer.getStats:%o', await consumer.getStats());
			}
		}, 1000);

	}

}

module.exports = Room;
