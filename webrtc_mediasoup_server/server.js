process.title = 'webrtc_mediasoup_server';    //设置进程名

const config = require('./config');
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
//const url = require('url');
//const protoo = require('protoo-server');
const mediasoup = require('mediasoup');
const { AwaitQueue } = require('awaitqueue');   //等待队列
//const Logger = require('./Logger');
const Room = require('./lib/Room');



//const logger = new Logger();
const queue = new AwaitQueue(); //用于管理文件室的异步队列
const rooms = new Map();
const peers = new Map();
let httpsServer;
const mediasoupWorkers = [];
let nextMediasoupWorkerIdx = 0;
var serverID = '';
var socket;

run();


async function run() {
    // 启动进程
    await runMediasoupWorkers();

    // 启动https服务
	await runHttpsServer();

    // 启动WebSocket服务
	await runWebSocketServer();
}


async function runMediasoupWorkers() {
    const { numWorkers } = config.mediasoup;    //获取配置文件Worker数
	console.log('running %d mediasoup Workers...', numWorkers);

    for (let i = 0; i < numWorkers; ++i) {
        const worker = await mediasoup.createWorker({   //创建Worker
            logLevel   : config.mediasoup.workerSettings.logLevel,	//设置日志级别
            logTags    : config.mediasoup.workerSettings.logTags,	//设置日志标签
            rtcMinPort : Number(config.mediasoup.workerSettings.rtcMinPort),    //用于 ICE、DTLS、RTP 等的最小 RTC 端口
            rtcMaxPort : Number(config.mediasoup.workerSettings.rtcMaxPort)     //用于 ICE、DTLS、RTP 等的最大 RTC 端口
        });

        worker.on('died', () => {
            console.log('mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);
			setTimeout(() => process.exit(1), 2000);
        });

        mediasoupWorkers.push(worker);

        // 每X秒记录一次工作资源使用情况。
        /*setInterval(async () => {
			const usage = await worker.getResourceUsage();
			console.log('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
		}, 120000);*/

    }
}


async function runHttpsServer() {
	console.log('running an HTTPS server...');

    const tls = {
		cert : fs.readFileSync(config.https.tls.cert),
		key  : fs.readFileSync(config.https.tls.key)
	};

    httpsServer = https.createServer(tls);

    /*await new Promise((resolve) => {
		httpsServer.listen(
		Number(config.https.listenPort), config.https.listenIp, resolve);
	});*/
    httpsServer.listen( Number(config.https.listenPort), () => 
        console.log('Socket Server listening on port %d', config.https.listenPort)
    );
}


async function runWebSocketServer() {
    console.log('running WebSocketServer...');

    socket = new WebSocket(config.wss.address);

	socket.addEventListener('open', handleSocketOpen);
	socket.addEventListener('message', handleSocketMessage);
	socket.addEventListener('error', handleSocketError);
	socket.addEventListener('close', handleSocketClose);
}

async function handleSocketOpen() {
	console.log('handleSocketOpen()');

	socket.send(JSON.stringify({"password":config.wss.password,"username":config.wss.username,"type":"server_online"}));
	setInterval(async () => {
		socket.send(JSON.stringify({"type":"pong"}));
	}, 60000);
};

async function handleSocketMessage(message) {
	try {
		const jsonMessage = JSON.parse(message.data);
		console.log('SocketMessage:%o', jsonMessage);

		if( jsonMessage.data ){
			handleJsonMessage(jsonMessage.data);
		}		
	  } catch (error) {
		console.error('handleSocketMessage() failed [error:%o]', error);
	  }
};

async function handleSocketError() {
	console.error('handleSocketError() [error:%o]', error);
};

async function handleSocketClose() {
	console.log('handleSocketClose()');
};


//处理Socket消息
async function handleJsonMessage(jsonMessage) {
	const { action } = jsonMessage;
	const { peerId } = jsonMessage;
	const { roomId } = jsonMessage;
	let room;
	let peer;
	let transportId;
	let dtlsParameters;
	let kind;
	let rtpParameters;
	let rtpCapabilities;
	let sctpCapabilities;

	switch (action) {
		case 'server_login':

			serverID = jsonMessage.prefix + jsonMessage.id;
			break;

		case 'create_room':

			if (!roomId || !peerId)	{
				console.log('Connection request without roomId and/or peerId');
				socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
					action: 'peer_join',
					peerId,
					result: 'fail',
					meg: 'Connection request without roomId and/or peerId'
				}}));
				return;
			}
			if ( peers.has(peerId) ) {
				console.log('create_room:peerId already exists:%s', peerId);

				const peer = peers.get(peerId);
				room = rooms.get(peer.roomId);
				if (!room) {
					console.log(`create_room:room with id ${roomId} was not found`);
					return;
				}
				await room.leave({ peerId });
				peers.delete(peerId);
			}

			// 将此代码序列化到队列中，以避免使用相同roomId同时连接的两个对等方创建具有相同roomId的两个单独的房间。
			queue.push(async () => {
				room = await getOrCreateRoom({ roomId });

				socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
					action: 'getRouterRtpCapabilities',
					peerId,
					routerRtpCapabilities: await room.getRouterRtpCapabilities()
				}}));				
			}).catch((error) => {
				console.log('room creation or room joining failed:%o', error);
			});

			break;

		case 'peer_join':

			room = rooms.get(roomId);
			if (!room) {
				console.log(`peer_join:room with id ${roomId} was not found`);
				return;
			}

			let device = jsonMessage.device;
			rtpCapabilities = jsonMessage.rtpCapabilities;
			sctpCapabilities = jsonMessage.sctpCapabilities;
			peer = await room.join({ peerId, device, rtpCapabilities, sctpCapabilities });

			peers.set(peerId, peer);
			socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
				action: 'peer_join',
				peerId,
				result: 'success'
			}}));


			break;
		
		case 'peer_close':

			console.log('Peer close:%s]', peerId);

			room = rooms.get(roomId);
			if (!room) {
				console.log(`peer_close:room with id ${roomId} was not found`);
				return;
			}
			await room.leave({ peerId });
			peers.delete(peerId);

			break;

		case 'createWebRtcTransport':

			room = rooms.get(roomId);
			if (!room) {
				console.log(`createWebRtcTransport:room with id ${roomId} was not found`);
				return;
			}
			try{
				let producing = jsonMessage.producing;
				let consuming = jsonMessage.consuming;
				let forceTcp = jsonMessage.forceTcp;
				sctpCapabilities = jsonMessage.sctpCapabilities;
				socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
					...await room.createWebRtcTransport({ peerId, forceTcp, producing, consuming, sctpCapabilities }),
					action: 'createWebRtcTransport'
				}}));
			}catch (error){
				console.log('createWebRtcTransport failed: %o', error);
			}

			break;

		case 'connectWebRtcTransport':

			transportId = jsonMessage.transportId;
			dtlsParameters = jsonMessage.dtlsParameters;
			room = rooms.get(roomId);
			if (!room) {
				console.log(`connectWebRtcTransport:room with id ${roomId} was not found`);
				return;
			}
			try{
				socket.send(JSON.stringify({'type':'re_server_data','to_id':peerId,'from_id':serverID,'data':{
					...await room.connectWebRtcTransport({ peerId, transportId, dtlsParameters }),
					action: 'connectWebRtcTransport',
					peerId
				}}));
			}catch (error){
				console.log('connectWebRtcTransport failed: %o', error);
			}

			break;

		case 'produce':

			transportId = jsonMessage.transportId;
			kind = jsonMessage.kind;
			rtpParameters = jsonMessage.rtpParameters;
			let appData = jsonMessage.appData;
			room = rooms.get(roomId);
			if (!room) {
				console.log(`produce:room with id ${roomId} was not found`);
				return;
			}
			try{
				await room.produce({ peerId, transportId, kind, rtpParameters, appData, socket, serverID, peers });
			}catch (error){
				console.log('produce failed: %o', error);
			}

			break;

		case 'createConsumer':

			room = rooms.get(roomId);
			if (!room) {
				console.log(`createConsumer:room with id ${roomId} was not found`);
				return;
			}
			await room.createConsumer({ socket, peerId, serverID });

			break;

		case 'consumer':

			room = rooms.get(roomId);
			let consumerId = jsonMessage.consumerId;
			if (!room) {
				console.log(`consumer:room with id ${roomId} was not found`);
				return;
			}
			await room.consumerResume({ peerId, consumerId });

			break;

		case 'byebye':

			if ( peers.has(peerId) ) {
				console.log('byebye:peerId already exists:%s', peerId);
				room = rooms.get(roomId);
				if (!room) {
					console.log(`byebye:room with id ${roomId} was not found`);
					return;
				}
				await room.leave({ peerId });
				peers.delete(peerId);
			}

			break;

		default: console.log('handleJsonMessage() unknown action %o', jsonMessage);
  	}
};


// 获取房间实例（如果不存在，则创建一个）
async function getOrCreateRoom({ roomId }) {
	let room = rooms.get(roomId);

	// 如果房间不存在，请创建一个新房间
	if (!room) {
		console.log('creating a new Room [roomId:%s]', roomId);
		const mediasoupWorker = getMediasoupWorker();

		room = await Room.create({ mediasoupWorker, roomId });
		rooms.set(roomId, room);
		room.on('close', () => rooms.delete(roomId));
	}

	return room;
}


// 找下一个mediasoup Worker
function getMediasoupWorker() {
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
		nextMediasoupWorkerIdx = 0;

	return worker;
}







