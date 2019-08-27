const pigpio = require('pigpio-client').pigpio({host: 'localhost'});
const async = require('async');


// Errors are emitted unless you provide API with callback.
pigpio.on('error', (err)=> {
  console.log('Application received error: ', err.message); // or err.stack
});
pigpio.on('disconnected', (reason) => {
  console.log('App received disconnected event, reason: ', reason);
  console.log('App reconnecting in 1 sec');
  setTimeout( pigpio.connect, 1000, {host: 'localhost'});
});

function mod(n, m) {
  return ((n % m) + m) % m;
}

class AC_Plugin {
	constructor(name, model) {
		this._name = name;
		this._model = model;
		this._frame = [];

		this._TEMP_MAX = 30;
		this._TEMP_MIN = 18;
		this._TEMP = 22;		//Default temp

		this._FAN_OPTIONS = {AUTO:0, QUIET:1, LOW:2, MED:3, HIGH:4};
		this._FAN = this._FAN_OPTIONS.AUTO;		//Def fan

		this._MODE_OPTIONS = {AUTO:0, COOL:1, DRY:2, HEAT:4, FAN:6};
		this._MODE = this._MODE_OPTIONS.AUTO;	//Def mode

		this._SWING_OPTIONS = {OFF:0, SWING:6};
		this._SWING = this._SWING_OPTIONS.OFF;

		//Hardware settings, sample:
		this._FIRST_PULSE = 9000;
		this._SECOND_PULSE = 4500;
		this._GAP_PULSE = 600;
		this._ONE_PULSE = 1650;
		this._ZERO_PULSE = 550;

		this._RC_Object = null;
		this.ready = new Promise((resolve,reject) => {
			pigpio.once('connected', (info) => {
			  // display information on pigpio and connection status
// 				console.log(JSON.stringify(info,null,2));
				console.log("pigpiod connected.")
				this._RC_Object = pigpio.gpio(17);
				resolve();
			})
		})
	}
	get name() {
		return this._name;
	}
	get model() {
		return this._model;
	}
	get frame() {
		return this._frame;
	}

	setTemp(temp) {
		if(temp > this._TEMP_MAX) temp = this._TEMP_MAX;
		else if(temp < this._TEMP_MIN) temp = this._TEMP_MIN;
		this._TEMP = temp;
		return temp;
	}
	setFan(fan) {
		if(!(fan in this._FAN_OPTIONS)) return false;
		this._FAN = this._FAN_OPTIONS[fan];
		return fan;
	}
	setMode(mode) {
		if(!(mode in this._MODE_OPTIONS)) return false;
		this._MODE = this._MODE_OPTIONS[mode];

		console.log('Setting mode to ' + mode);

		return mode;
	}
	setSwing(swing) {
		if(!(swing in this._SWING_OPTIONS)) return false;
		this._SWING = this._SWING_OPTIONS[swing];
		return swing;
	}

	turnOff() {
		console.log('Set turning off...');
	}

	turnOn() {
		console.log('Set turning on...');
	}

	//Utils:
	setByte(byte_val, byte_no) {
		this._frame[byte_no-1] = byte_val;
	}
	getByte(byte_no) {
		return this._frame[byte_no-1];
	}
	checkSum(checksum=0) {
		return checksum;
	}
	printFrame(frame=this.frame) {
		let n = 0;
		let i = 0;
		frame.forEach((item, index) => {
			n = item.toString(2);
			i = (index+1).toString(10);
// 			console.log(i + " " + item);
			console.log("   ".substr(i.length)+i + " " + "00000000".substr(n.length) + n);
		});
	}

	bin2raw(frame=this._frame) {
		let rawcode = [this._FIRST_PULSE, this._SECOND_PULSE, this._GAP_PULSE];
		const checksum = this.checkSum();
		if(checksum !== false) this.setByte(checksum,this.frame.length);	//Update checksum
		frame.forEach((byte, index) => {
			var i=8;
			while(i>0) {
				var lastbit = byte & 1;
				byte = byte >> 1;
				if(lastbit) rawcode.push(this._ONE_PULSE);
				else rawcode.push(this._ZERO_PULSE);
				rawcode.push(this._GAP_PULSE);
				i--;
			}
		});
		return rawcode;
	}
	printRaw(rawcode) {
		rawcode.forEach((item,index) => {
			var n = item.toString();
			process.stdout.write("         ".substr(n.length) + n);
			if((index+1) % 6 == 0) console.log();
		});
		console.log();
	}
	addCarrier(code, duration) {
		const oneCycleTime = 1000000.0 / 38000;
		const onDuration = (oneCycleTime * 0.5).toFixed(0);
		const offDuration = onDuration;
		const totalCycles = (duration / oneCycleTime).toFixed(0);
		let totalPulses = totalCycles * 2;

		while(totalPulses > 0) {
			if(totalPulses % 2) {
				code.push([0, 1, onDuration]);
			}
			else {
				code.push([1, 0, offDuration]);
			}
			totalPulses--;
		}
		return code;
	}
	addGap(code, duration) {
		code.push([1, 0, duration]);
		return code;
	}
	makeWave(frame=this.frame) {
		const rawcode = this.bin2raw(this.frame);
		let wave = [];

		rawcode.forEach((item, index) => {
			if(index % 2 == 0) {
				wave = this.addCarrier(wave, item);
			}
			else {
				wave = this.addGap(wave, item);
			}
		})
		wave.push([1, 0, 0]);
		wave.push([0, 1, 0]);	//Turn off IR-diode or it may be burn out!!

		return wave;

	}
	async sendWave() {
		const wave = this.makeWave();
		const chunklen = 2000;
		const wavelen = wave.length;

		let codechunks = Math.floor(wavelen / chunklen);
		let wavechain = [];

		await this.ready;

		console.log("t=" + this._TEMP + "; mode=" + this._MODE + "; swing=" + this._SWING + "; fan=" + this._FAN);

		const AirconRC = this._RC_Object;

		if(!AirconRC) {
			console.log("Cannot initialize RC! Quitting...");
			return false;
		}

		let cmdQueue = [
			(cb) => AirconRC.waveClear((error,data) => {
				if(error) return cb(error);
				cb(null);
			})
		];

		for(let i = 0; i <= codechunks; i++) {
			cmdQueue.push(
				(cb) => {
					AirconRC.waveAddPulse(wave.slice(0+i*chunklen, i*chunklen+chunklen), (error,data) => {
						if(error) return cb(error);
						console.log('Adding '+ i + ' chunk...');
						cb(null);
					});
				}
			);
			cmdQueue.push(
				(cb) => {
					AirconRC.waveCreate((error,data) => {
						if(error) return cb(error);
						wavechain.push(data);
						cb(null,data);
					})
				}
			);
		}

		cmdQueue.push(
			(cb) => {
				AirconRC.waveChainTx([{waves: wavechain}], (error, data) => {
					if(error) return cb(error);
					console.log('Transmitted');
					AirconRC.write(0);
					cb(null);
				})
			}
		);

		this.printFrame();	//For debug
		console.log('Wave length: '+wavelen);

		AirconRC.modeSet('output');

		async.series(cmdQueue, (err, result) => {
			if(err) console.log(err);
		});

	}
	setRc(rc) {
		this._RC_Object = rc;
	}
}
class Fujitsu_Plugin extends AC_Plugin {
	constructor() {
		super("fujitsu", "Fujitsu RC AR-RAE1E");
		this._standart_frame = [
			0b00010100, // 14  01
			0b01100011, // 63  02
			0b00000000, // 00  03
			0b00010000, // 10  04
			0b00010000, // 10  05
			0b11111110, // FE  06
			0b00001001, // 09  07
			0b00110000, // 30  08
			0b10000001, // 81  09 - Temp -16 (24-16=8) first 4 bits from left,
						//			Last bit from left sets when Start button was pressed
			0b00000001, // 01  10 - Mode: 000-auto,001-cool,010-dry,011-fan,100-heat
			0b00000000, // 00  11 - Fan speed: last 3 bits from right: 000-auto, 001-high, 010-med, 011-low, 100-quiet
						//			Swing: on/off - 4 bit from left
			0b00000000, // 00  12
			0b00000000, // 00  13
			0b00000000, // 00  14
			0b00100000, // 20  15 - Eco on/off - 3 bit from left
			0b00101110  // 2E  16 - CRC (208 - (from 8 to 15 bytes sum)) % 256
		];

		this._turnoff_frame = [		//Fixed turnoff frame
			0b00010100, // 14
			0b01100011, // 63
			0b00000000, // 00
			0b00010000, // 10
			0b00010000, // 10
			0b00000010, // 02
			0b11111101  // FD
		];

		this._frame = this._standart_frame;

		this._FAN_OPTIONS = {AUTO: 0, QUIET: 4, LOW: 3, MED: 2, HIGH: 1};
		this._FAN = this._FAN_OPTIONS.AUTO;

		this._MODE_OPTIONS = {AUTO: 0, COOL: 1, DRY: 2, HEAT: 4, FAN: 3};
		this._MODE = this._MODE_OPTIONS.AUTO;

		this._SWING_OPTIONS = {OFF: 0, SWING: 1};
		this._SWING = this._SWING_OPTIONS.OFF;

		//Hardware settings for Fujitsu:
		this._FIRST_PULSE = 3320;
		this._SECOND_PULSE = 1580;
		this._GAP_PULSE = 420;
		this._ONE_PULSE = 1190;
		this._ZERO_PULSE = 400;
	}

	setTemp(temp) {
		temp = super.setTemp(temp);

		const mdfy_temp = (temp - 16) << 4;
		const byte_temp = this.getByte(9) & 0b00001111;	//Clear first four bytes
		this.setByte(mdfy_temp | byte_temp, 9);
		return temp;
	}
	setFan(fan) {
		if(!super.setFan(fan)) {
			console.log("Setting fan fail!");
			return false;
		}
		const byte_fan = this.getByte(11) & 0b11111000;
		this.setByte(byte_fan | this._FAN_OPTIONS[fan],11);

		return fan;

	}
	setMode(mode) {
		if(!super.setMode(mode)) {
			console.log("Setting mode fail!");
			return false;
		}
		const byte_mode = this.getByte(10) & 0b11111000;
		this.setByte(byte_mode | this._MODE_OPTIONS[mode],10);

		return mode;
	}
	setSwing(swing) {
		if(!super.setSwing(swing)) {
			console.log("Setting swing fail!");
			return false;
		}

		const byte_swing = this.getByte(11);
		if(this._SWING_OPTIONS[swing]) this.setByte(byte_swing | 0b00010000);
		else this.setByte(byte_swing & 0b11101111);

		return swing;
	}

	turnOn() {
		super.turnOn();
		this._frame = this._standart_frame;

		const on_byte = this.getByte(9);
		this.setByte(on_byte | 0b00000001, 9);
	}
	turnOff() {
		super.turnOff();
		this._frame = this._turnoff_frame;
	}
	checkSum(checksum=0) {
		if(this._frame.length != 16) return false;

		const dataframe = this._frame.slice(8,15);
		let bytesum = 0;
		dataframe.forEach((item, index) => {
			bytesum += item;
		});
		return super.checkSum(mod((208 - bytesum), 256));
	}
}
class Zanussi_Plugin extends AC_Plugin {
	constructor() {
		super("zanussi", "Zanussi RC YKR-L/102E");
		this._frame = [
			0b11000011,     // 01 - May be type of header?
			0b01110111,     // 02 - Temp 22 - 8 (first five bits from left), SWING last three bits (000 - on, 111 - off)
			0b11100000,     // 03 -
			0b00000000,     // 04 - first bit means +0.5 to the Temp
			0b10100000,     // 05 - Fan speed first 3 bits(001-HIGH, 010-MED, 011-LOW, 101-AUTO)
			0b00000000,     // 06 -
			0b00000000,     // 07 - mode first 3 bits (001-COOL,100-HEAT,000-auto,010-dry,110-fan)
			0b00000000,     // 08 -
			0b00000000,     // 09 -
			0b00100000,     // 10 - 3-d byte means On|Off
			0b00000000,     // 11 -
			0b00000101,     // 12 - Pressed key code (I believe) 00000101 - for this frame
			0b00000000      // 13 - CRC (Modulo 256)
		];

		this._FAN_OPTIONS = {AUTO: 5, QUIET:3, LOW: 3, MED: 2, HIGH: 1};
		this._FAN = this._FAN_OPTIONS.AUTO;

		this._MODE_OPTIONS = {AUTO:0, COOL:1, DRY:2, HEAT:4, FAN:6};
		this._MODE = this._MODE_OPTIONS.AUTO;

		this._SWING_OPTIONS = {OFF:7, SWING:0};
		this._SWING = this._SWING_OPTIONS.OFF;

		//Hardware settings for Zanusssi:
		this._FIRST_PULSE = 9000;
		this._SECOND_PULSE = 4500;
		this._GAP_PULSE = 600;
		this._ONE_PULSE = 1650;
		this._ZERO_PULSE = 550;

	}

	setTemp(temp) {		//18 - min temp

		if(temp < this._TEMP) this.setByte(0b00000001,12);
		if(temp > this._TEMP) this.setByte(0,12);

		temp = super.setTemp(temp);

		const mdfy_temp = (temp - 8) << 3;				//temp is in first five bytes so we shift it by 3
		const byte_temp = this.getByte(2) & 0b00000111;	//clear first five bytes
		this.setByte(mdfy_temp | byte_temp, 2);
		return temp;
	}

	setFan(fan) {
		if(!super.setFan(fan)) {
			console.log("Setting fan fail!");
			return false;
		}
// 		console.log("setting fan to " + this._FAN_OPTIONS[fan]);
		const mdfy_fan = this._FAN_OPTIONS[fan] << 5;
		const byte_fan = this.getByte(5) & 0b00011111;
		this.setByte(mdfy_fan | byte_fan, 5);

		this.setByte(0b00000100, 12);

		return fan;
	}

	setMode(mode) {
		if(!super.setMode(mode)) {
			console.log("Setting mode fail!");
			return false;
		}
		const mdfy_mode = this._MODE_OPTIONS[mode] << 5;
		const byte_mode = this.getByte(7) & 0b00011111;
		this.setByte(mdfy_mode | byte_mode, 7);

		this.setByte(0b00000110, 12);

		if(mode === 'HEAT') {
			this.setByte(0b00110000, 10);
		}
		else this.setByte(0b00100000, 10);

		return mode;
	}

	setSwing(swing) {
		if(!super.setSwing(swing)) {
			console.log("Setting swing fail!");
			return false;
		}
		const mdfy_swing = this._SWING_OPTIONS[swing];
		const byte_swing = this.getByte(2) & 0b11111000;
		this.setByte(mdfy_swing | byte_swing, 2);

		this.setByte(0b00000010, 12);

		return swing;
	}

	turnOn() {
		super.turnOn();
		const byteoff = this.getByte(10);
		this.setByte(byteoff | 0b00100000, 10);
	}

	turnOff() {
		super.turnOff();
		const byteoff = this.getByte(10);
		this.setByte(byteoff & 0b11011111, 10);
		this.setByte(0b00000101,12);
	}

	checkSum(checksum=0) {

		const dataframe = this._frame.slice(0,12);
		let bytesum = 0;
		dataframe.forEach((item, index) => {
			bytesum += item;
		});
		//return super.checkSum(mod(bytesum, 256));
		return super.checkSum(bytesum % 256);
	}
}

//const zanussi = new Zanussi_Plugin();

exports.plugin = function(name) {
	let plugin = false;
	if(name === 'zanussi') plugin = new Zanussi_Plugin();
	if(name === 'fujitsu') plugin = new Fujitsu_Plugin();
	return plugin;
}