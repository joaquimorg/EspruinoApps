{ // execute in our own scope so we don't have to free variables...
    //E.showMessage("Updating boot...");

    Pinetime.setLCDPower(true);
    Pinetime.setLCDBrightness(0.4);
    Pinetime.setLCDTimeout(15);

    var bleServices = {}, bleServiceOptions = { uart: true };

    Bluetooth.line = "";

    Bluetooth.on('data', function (d) {
        var l = (Bluetooth.line + d).split(/[\\n\\r]/);
        Bluetooth.line = l.pop();
        l.forEach(n => Bluetooth.emit("line", n));
    });

    Bluetooth.on('line', function (l) {
        if (l.startsWith('\x10')) l = l.slice(1);
        if (l.startsWith('GB({') && l.endsWith('})') && global.GB)
            try { global.GB(JSON.parse(l.slice(3, -1))); } catch (e) { }
    });

    E.setTimeZone(1);

    NRF.setServices(bleServices, bleServiceOptions);
    delete bleServices, bleServiceOptions;


    (function () {

        function gbSend(message) {
            Bluetooth.println("");
            Bluetooth.println(JSON.stringify(message));
        }

        var lastMsg; // for music messages - may not be needed now...

        var _GB = global.GB;

        global.GB = (event) => {
            // feed a copy to other handlers if there were any
            if (_GB) setTimeout(_GB, 0, Object.assign({}, event));

            var HANDLERS = {
                // {t:"notify",id:int, src,title,subject,body,sender,tel:string} add
                "notify": function () {
                  //console.log(event);
                  Object.assign(event,{t:"add",positive:true, negative:true});
                  if (lastMsg && event.body == lastMsg.body && lastMsg.src == undefined && event.src == "Messages") {
                    // Mutate the other message
                    event.id = lastMsg.id;
                  }
                  lastMsg = event;
                  require("messages").pushMessage(event);
                },
                // {t:"notify~",id:int, title:string} // modified
                "notify~": function () {
                  event.t="modify";require("messages").pushMessage(event);
                },
                // {t:"notify-",id:int} // remove
                "notify-": function () {
                  event.t="remove";require("messages").pushMessage(event);
                },
                // {t:"find", n:bool} // find my phone
                "find": function () {
                },
                // {t:"musicstate", state:"play/pause",position,shuffle,repeat}
                "musicstate": function () {
                },
                // {t:"musicinfo", artist,album,track,dur,c(track count),n(track num}
                "musicinfo": function () {
                },
                // {"t":"call","cmd":"incoming/end","name":"Bob","number":"12421312"})
                "call": function () {
                  Object.assign(event, {
                    t:event.cmd=="incoming"?"add":"remove",
                    id:"call", src:"Phone",
                    positive:true, negative:true,
                    title:event.name||/*LANG*/"Call", body:/*LANG*/"Incoming call\n"+event.number});
                  require("messages").pushMessage(event);
                },
                // {"t":"alarm", "d":[{h:int,m:int,rep:int},... }
                "alarm": function () {
                },
                // {t:"calendar", id:int, type:int, timestamp:seconds, durationInSeconds, title:string, description:string,location:string,calName:string.color:int,allDay:bool
                "calendar": function () {
                },
                // {t:"calendar-", id:int}
                "calendar-": function () {
                },
                //triggered by GB, send all ids
                // { t:"force_calendar_sync_start" }
                "force_calendar_sync_start": function () {
                    var cal = [];
                    gbSend({ t: "force_calendar_sync", ids: cal.map(e => e.id) });
                },
                // {t:"http",resp:"......",[id:"..."]}
                "http": function () {
                    //get the promise and call the promise resolve
                    if (Pinetime.httpRequest === undefined) return;
                    var request = Pinetime.httpRequest[event.id];
                    if (request === undefined) return; //already timedout or wrong id
                    delete Pinetime.httpRequest[event.id];
                    clearTimeout(request.t); //t = timeout variable
                    if (event.err !== undefined) //if is error
                        request.j(event.err); //r = reJect function
                    else
                        request.r(event); //r = resolve function
                },
                // {t:"gps", lat, lon, alt, speed, course, time, satellites, hdop, externalSource:true }
                "gps": function () {
                },
                // {t:"is_gps_active"}
                "is_gps_active": function () {
                },
                // {t:"act", hrm:bool, stp:bool, int:int}
                "act": function () {
                },
                "nav": function () {
                }
            };

            var h = HANDLERS[event.t];
            if (h) h(); else console.log("GB Unknown", event);
        };


        // HTTP request handling - see the readme
        // options = {id,timeout,xpath}
        Pinetime.http = (url, options) => {
            options = options || {};
            if (!NRF.getSecurityStatus().connected)
                return Promise.reject(/*LANG*/"Not connected to Bluetooth");
            if (Pinetime.httpRequest === undefined)
                Pinetime.httpRequest = {};
            if (options.id === undefined) {
                // try and create a unique ID
                do {
                    options.id = Math.random().toString().substr(2);
                } while (Pinetime.httpRequest[options.id] !== undefined);
            }
            //send the request
            var req = { t: "http", url: url, id: options.id };
            if (options.xpath) req.xpath = options.xpath;
            if (options.return) req.return = options.return; // for xpath
            if (options.method) req.method = options.method;
            if (options.body) req.body = options.body;
            if (options.headers) req.headers = options.headers;
            gbSend(req);
            //create the promise
            var promise = new Promise(function (resolve, reject) {
                //save the resolve function in the dictionary and create a timeout (30 seconds default)
                Pinetime.httpRequest[options.id] = {
                    r: resolve, j: reject, t: setTimeout(() => {
                        //if after "timeoutMillisec" it still hasn't answered -> reject
                        delete Pinetime.httpRequest[options.id];
                        reject("Timeout");
                    }, options.timeout || 30000)
                };
            });
            return promise;
        };

        // Battery monitor
        function sendBattery() { 
          gbSend({ t: "status", bat: E.getBattery(), chg: Pinetime.isCharging() ? 1 : 0 });
          gbSend({
              t: "act",
              ts: 0,
              stp: Pinetime.getStepCount(),
              hrm: 0,
              mov: 0
            });
        }
        Pinetime.on("charging", sendBattery);
        NRF.on("connect", () => setTimeout(function () {
            sendBattery();
            gbSend({t: "ver", fw: process.env.VERSION, hw: process.env.HWVERSION});
            GB({ t: "force_calendar_sync_start" }); // send a list of our calendar entries to start off the sync process
        }, 2000));
        NRF.on("disconnect", () => {
            // disable HRM/activity monitoring ('act' message)
            GB({ t: "act", stp: 0, hrm: 0, int: 0 }); // just call the handler to save duplication
            // remove all messages on disconnect (if enabled)
            //var settings = require("Storage").readJSON("android.settings.json", 1) || {};
            /*if (!settings.keep)
                require("messages").clearAll();*/
        });
        setInterval(sendBattery, 10 * 60 * 1000);

        Pinetime.messageResponse = (msg,response) => {
          if (msg.id=="call") return gbSend({ t: "call", n:response?"ACCEPT":"REJECT" });
          if (isFinite(msg.id)) return gbSend({ t: "notify", n:response?"OPEN":"DISMISS", id: msg.id });
          // error/warn here?
        };
        Pinetime.messageIgnore = msg => {
          if (isFinite(msg.id)) return gbSend({ t: "notify", n:"MUTE", id: msg.id });
        };

        Pinetime.on("message", (type, msg) => require("messagegui").listener(type, msg));

    })();
    // load("clock.js");
    eval(require('Storage').read('clock.js'));
}


