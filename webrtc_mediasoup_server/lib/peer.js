// Class to hold peer data 类来保存对等数据

module.exports = class Peer {
  constructor (peerId, roomId) {
    // 存储mediasoup相关对象
    this.peerId = peerId;
    this.roomId = roomId;
    this.joined = false;
    this.device = undefined;
		this.rtpCapabilities = undefined;
		this.sctpCapabilities = undefined;
    //存储mediasoup相关的映射
		this.transports = new Map();
		this.producers = new Map();
		this.consumers = new Map();
    // 新加，保存视频用
		this.remotePorts = [];
		this.rtpconsumers =[];
		this.process = undefined;
		this.recordInfo = {};
  }

}
