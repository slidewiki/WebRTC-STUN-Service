'use strict';

const Joi = require('joi'),
  server = require('./server'),
  os = require('os'),
  twitter = require('twitter'),
  _ = require('lodash'),
  crypto = require('crypto');

const twitterclient = new twitter(require('./config.json'));

let CORSHost = process.env.VIRTUAL_HOST.split('.');
CORSHost = CORSHost[CORSHost.length - 2] + '.' + CORSHost[CORSHost.length-1];
console.log('Using ' + CORSHost + ' for CORS headers');

module.exports = function(server) {
  server.route({
    method: 'GET',
    path: '/rooms/{deckID}',
    handler: getRoomsForPresentaton,
    config: {
      validate: {
        params: {
          deckID: Joi.string().lowercase().trim()
        },
      },
      plugins: {
        'hapi-swagger': {
          deprecated: true,
        }
      },
      tags: ['api'],
      description: 'Get rooms for a specific deck'
    }
  });

  server.route({
    method: 'GET',
    path: '/v2/rooms/{deckID}',
    handler: getRoomsForDeckWithTime,
    config: {
      validate: {
        params: {
          deckID: Joi.string().lowercase().trim()
        },
      },
      tags: ['api'],
      description: 'Get rooms for a specific deck with their opening time'
    }
  });

  server.route({
    method: 'GET',
    path: '/token',
    handler: getNewRevealMultiplexToken,
    config: {
      cors: {origin: [/*'http://localhost*',*/ '*' + CORSHost]},
      tags: ['api'],
      description: 'Get a new token pair for the reveal multiplex plugin'
    }
  });
};

let rooms = {};//{deckid: [{roomName: string, openingTime: UTC, twitterStream: stream}, ...], ...}

function getRoomsForPresentaton(request, reply) {//NOTE still here for backward compatibility
  let id = request.params.deckID;
  let response = rooms[id] ? rooms[id] : [];
  response = response.map((room) => room.roomName);
  reply(response);
}

function getRoomsForDeckWithTime(request, reply) {
  let id = request.params.deckID;
  let response = rooms[id] ? rooms[id] : [];
  reply(response.map((el) => {return {'roomName': el.roomName, 'openingTime': el.openingTime};}));
}

function getNewRevealMultiplexToken(request, reply) {
  let ts = new Date().getTime();
  let rand = Math.floor(Math.random()*9999999);
  let secret = ts.toString() + rand.toString();
  let socketID = createHash(secret);
  console.log({secret: secret, socketId: socketID});
  reply({secret: secret, socketId: socketID});
}

function createHash(secret) {
  let cipher = crypto.createCipher('blowfish', secret);
  return(cipher.final('hex'));
}

let io = require('socket.io')(server.listener);
io.on('connection', (socket) => {

  function log() {
    let array = ['Message from server:'];
    array.push.apply(array, arguments);
    socket.emit('log', array);
    // console.log('log', array);
  }

  function RoomParticipants(room) {
    return io.sockets.adapter.rooms[room] ? io.sockets.adapter.rooms[room].length : 0;
  }

  socket.on('message', (data) => {
    log('Client said: ', data);
    if (data.cmd === 'peer wants to connect')
      socket.emit('message', data);
    io.to(data.receiver).emit('message', data);
  });

  socket.on('ID of presenter', (presenterID, peerID) => {
    io.to(peerID).emit('ID of presenter', presenterID);
  });

  socket.on('room is full', (peerID) => {
    io.to(peerID).emit('room is full');
  });

  socket.on('create or join', (room, deckID) => {
    log('Received request to create or join room ' + room);
    //console.log('Received request to create or join room ', room);
    //console.log('Number of all currently connected sockets: ', Object.keys(io.sockets.sockets).length);

    if (RoomParticipants(room) === 0) {
      log('Client ID ' + socket.id + ' created room ' + room);
      let now = new Date().getTime();
      if(rooms[deckID])
        rooms[deckID].push({'roomName': room, 'openingTime': now});
      else{
        rooms[deckID] = [];
        rooms[deckID].push({'roomName': room, 'openingTime': now});
      }
      socket.join(room).emit('created', room, socket.id);
    } else {
      log('Client ID ' + socket.id + ' joined room ' + room);
      io.sockets.in(room).emit('join', room, socket.id);
      socket.join(room).emit('joined', room, socket.id);
    }
  });

  socket.on('follow hashtag', (hashtags, room, deckID) => {//hashtags = '', e.g. ''#SWORG #D6R1'
    let stream = twitterclient.stream('statuses/filter', {track: hashtags});
    rooms[deckID].find((x) => x.roomName === room).twitterStream = stream;
    stream.on('data', (event) => {
      let isTweet = _.conformsTo(event,{
        contributors: (x) => {return _.isObject(x) || _.isEmpty(x);},
        id_str: _.isString,
        text: _.isString,
      });
      if(isTweet)
        socket.emit('new tweets', event);
    });

    stream.on('error', (error) => {
      console.log(error);
    });
  });

  socket.on('disconnecting', () => {//NOTE This will have bad performance for many peers/rooms/deckIDs
    let availableRooms = io.sockets.adapter.rooms;
    Object.keys(availableRooms).forEach((room) => {
      if(room !== socket.id && Object.keys(availableRooms[room].sockets).includes(socket.id) && availableRooms[room].length === 1){
        Object.keys(rooms).forEach((deckID) => {
          if(rooms[deckID].some((room2) => room2.roomName === room)) {
            try {
              rooms[deckID].find((x) => x.roomName === room).twitterStream.destroy();//close twitter stream
            } catch (e) {}//eslint-disable-line
            rooms[deckID] = rooms[deckID].filter((x) => x.roomName !== room);//remove from array
            if(rooms[deckID].length === 0)
              delete rooms[deckID];
          }
        });
      }
    });
  });

  socket.on('ipaddr', () => {
    let ifaces = os.networkInterfaces();
    for (let dev in ifaces) {
      ifaces[dev].forEach((details) => {
        if (details.family === 'IPv4' && details.address !== '127.0.0.1') {
          socket.emit('ipaddr', details.address);
        }
      });
    }
  });

  socket.on('multiplex-statechanged', (data) => {
    if (typeof data.secret == 'undefined' || data.secret == null || data.secret === '') return;
    if (createHash(data.secret) === data.socketId) {
      data.secret = null;
      socket.broadcast.emit(data.socketId, data);
    }
  });

});
