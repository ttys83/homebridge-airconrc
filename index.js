let Service, Characteristic;
let inherits = require('util').inherits;

const DEBUG = true;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;

	/**
	* Set custom Characterisic & Service
	* It is not recognize by Home.app, only by alternatives like Eve.app
	* Characteristic "CurrentAirPressure"
	*/

	Characteristic.CurrentAirPressure = function() {
	  Characteristic.call(this, 'CurrentAirPressure', '00000102-0000-1000-8000-0026BB765291');
	  this.setProps({
		unit: "mm",
		minValue: 500,
		maxValue: 1000,
		format: Characteristic.Formats.FLOAT,
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	  });
	  this.value = this.getDefaultValue();
	};

	inherits(Characteristic.CurrentAirPressure, Characteristic);

	Characteristic.CurrentAirPressure.UUID = '00000102-0000-1000-8000-0026BB765291';

	/**
	 * Service "Air Pressure Sensor"
	 */

	Service.AirPressureSensor = function(displayName, subtype) {
	  Service.call(this, displayName, '00000101-0000-1000-8000-0026BB765291', subtype);

	  // Required Characteristics
	  this.addCharacteristic(Characteristic.CurrentAirPressure);

	  // Optional Characteristics
	  this.addOptionalCharacteristic(Characteristic.Name);
	};

	inherits(Service.AirPressureSensor, Service);

	Service.AirPressureSensor.UUID = '00000101-0000-1000-8000-0026BB765291';

	homebridge.registerAccessory("airconrc-plugin", "Aircon remote control", HeaterCoolerRemote);
};

function debug(...args) {
	if(!DEBUG) return;
	this.log('DEBUG:',...args);
}

class HeaterCoolerRemote {
	constructor(log, config) {
		this.log = log;
		this.debug = debug;

		this.name = config.name || 'AC Remote';

		this.sensors = {
			temperature: 	null,		//Temperature sensor
			humidity:		null,		//Relative Humidity sensor
			airpressure:	null,		//Air pressure sensor
			eco2:			null,		//Carbon dioxide sensor
			tvoc:			null
		};

		for(const sensor of config.sensors) {
			const plugin = require("./" + sensor + "/" + sensor).plugin();
			for(const ability of plugin.getAbilities()) {
				if(ability === 'temperature') this.sensors.temperature = plugin;
				if(ability === 'humidity') this.sensors.humidity = plugin;
				if(ability === 'eco2') this.sensors.eco2 = plugin;
				if(ability === 'tvoc') this.sensors.tvoc = plugin;
				if(ability === 'airpressure') this.sensors.airpressure = plugin;
			}
		}

		this.aircon = require('./ac-plugins').plugin('zanussi');

        this.cmdTimeout = config.cmdTimeout || 2000; // millisecond, async send timeout
        this.updateInterval = config.updateInterval || 2000; // millisecond, sync interval

		this.targetTemperature = 23;
		this.defaultTargetState = Characteristic.TargetHeaterCoolerState.COOL;
		this.defaultCurrentState = Characteristic.CurrentHeaterCoolerState.COOLING;
		this.defaultRotationSpeed = "AUTO";

		this.Active;
		this.TargetHeaterCoolerState;
		this.CoolingThresholdTemperature;
		this.HeatingThresholdTemperature;
		this.SwingMode;
		this.RotationSpeed;

		this.CurrentHeaterCoolerState;
		this.CurrentTemperature;

		this.CurrentRelativeHumidity;

		this.CurrentAirPressure;

		//CO2 Detector:
		this.CarbonDioxideDetected;
		this.CarbonDioxidePeakLevel;
		this.CarbonDioxideLevel;

		//For air quality sensor:
		this.CarbonDioxideLevelAQ;
		this.VOCDensity;

        /* command timeout Handle */
        this.cmdHandle;

		this.services = [];

		this.addServices();
		this.bindCharacteristics();
		this.init();
		this.updateDash();

	}

	addServices() {

        this.serviceInfo = new Service.AccessoryInformation();
		this.serviceInfo
			.setCharacteristic(Characteristic.Manufacturer, 'Andrew Shmelev')
			.setCharacteristic(Characteristic.Model, 'Climate Controller')
			.setCharacteristic(Characteristic.SerialNumber, "000-000-556")
			.setCharacteristic(Characteristic.FirmwareRevision, "1.1");
		this.services.push(this.serviceInfo);

		this.acService = new Service.HeaterCooler("Кондиционер");
		this.services.push(this.acService);

        if (this.sensors.humidity) {
            this.humidityService = new Service.HumiditySensor("Влажность");
            this.services.push(this.humidityService);
        }

        if (this.sensors.eco2) {
        	this.CarbonDioxideService = new Service.CarbonDioxideSensor("CO2");
        	this.services.push(this.CarbonDioxideService);
        }

        if (this.sensors.eco2 || this.sensors.tvoc) {
        	this.airQualityService = new Service.AirQualitySensor("Кач.воздуха");
        	this.services.push(this.airQualityService);
        }

        if (this.sensors.airpressure) {
        	this.AirPressureService = new Service.AirPressureSensor("Давление");
        	this.services.push(this.AirPressureService);
        }
    }

	bindCharacteristics() {
	// HeaterCooler Service Characteristic
	// Required Characteristic:
		this.Active = this.acService.getCharacteristic(Characteristic.Active)
			.on('set', this._setActive.bind(this));

        this.TargetHeaterCoolerState = this.acService.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .on('set', this._setTargetHeaterCoolerState.bind(this));

        this.CurrentHeaterCoolerState = this.acService.getCharacteristic(Characteristic.CurrentHeaterCoolerState);

        this.CurrentTemperature = this.acService.getCharacteristic(Characteristic.CurrentTemperature);

    // Optional Characteristic:
        this.CoolingThresholdTemperature = this.acService.addCharacteristic(Characteristic.CoolingThresholdTemperature)
            .setProps({
                maxValue: 30,
                minValue: 16,
                minStep: 1
            })
            .on('set', this._setCoolingThresholdTemperature.bind(this))
            .updateValue(this.targetTemperature);

        this.HeatingThresholdTemperature = this.acService.addCharacteristic(Characteristic.HeatingThresholdTemperature)
            .setProps({
                maxValue: 30,
                minValue: 16,
                minStep: 1
            })
            .on('set', this._setHeatingThresholdTemperature.bind(this))
            .updateValue(this.targetTemperature);

		this.SwingMode = this.acService.addCharacteristic(Characteristic.SwingMode)
			.on('set', this._setSwingMode.bind(this));

		this.RotationSpeed = this.acService.addCharacteristic(Characteristic.RotationSpeed)
			.setProps({
				maxValue: 5,
                minValue: 0,
                minStep: 1
            })
            .on('set', this._setRotationSpeed.bind(this));

	//HumiditySensor Service Characteristic
	//Required Characteristic:
        if(this.sensors.humidity) {
			this.CurrentRelativeHumidity = this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity);
		}

	//AirQuality Service required Characteristic:
        if (this.sensors.eco2 || this.sensors.tvoc) {
			this.AirQuality = this.airQualityService.getCharacteristic(Characteristic.AirQuality);
		}

		if(this.sensors.eco2) {
			 this.CarbonDioxideLevelAQ = this.airQualityService.addCharacteristic(Characteristic.CarbonDioxideLevel);

			 this.CarbonDioxidePeakLevel = this.CarbonDioxideService.addCharacteristic(Characteristic.CarbonDioxidePeakLevel);
			 this.CarbonDioxideLevel = this.CarbonDioxideService.addCharacteristic(Characteristic.CarbonDioxideLevel);
			 this.CarbonDioxideDetected = this.CarbonDioxideService.getCharacteristic(Characteristic.CarbonDioxideDetected);
		}

		if(this.sensors.tvoc) {
			this.VOCDensity = this.airQualityService.addCharacteristic(Characteristic.VOCDensity);
		}

		if(this.sensors.airpressure) {
			this.CurrentAirPressure = this.AirPressureService.getCharacteristic(Characteristic.CurrentAirPressure)
		}
    }

    getServices() {
        return this.services;
    }

	init() {

		process.on('SIGINT', () => {

			this.debug("Handle SIGINT....");

		});

		this.Active.updateValue(Characteristic.Active.INACTIVE);

		if(this.sensors.temperature) {
			this.sensors.temperature.readTemperature()
				.then(data => this.CurrentTemperature.updateValue(data))
				.catch(console.log);
		} else this.CurrentTemperature.updateValue(this.targetTemperature);	//default

		if(this.sensors.humidity) {
			this.sensors.humidity.readHumidity()
				.then(data => this.CurrentRelativeHumidity.updateValue(data))
				.catch(console.log);
		}

		if(this.sensors.eco2 || this.sensors.tvoc) {
			this.CarbonDioxideDetected.updateValue(Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL);
			this.CarbonDioxidePeakLevel.updateValue(0);
			this.CarbonDioxideService.getCharacteristic(Characteristic.CarbonDioxideLevel)
				.updateValue(this.CarbonDioxideLevel.value);

			this.sensors.eco2.readSensorData()
				.then(data => {
					this.CarbonDioxideLevel.updateValue(data.eco2);
					this.VOCDensity.updateValue(data.tvoc);
				})
				.catch(err => this.log.error(err.message));

			const data = this._checkAirQuality();
			this.AirQuality.updateValue(data);
		}

		if (this.sensors.airpressure) {
			this.sensors.airpressure.readPressure()
				.then(data => this.CurrentAirPressure.updateValue(data))
				.catch(console.log);
		}

		this.TargetHeaterCoolerState.updateValue(this.defaultTargetState);
		this.CurrentHeaterCoolerState.updateValue(this.defaultCurrentState);
		this.RotationSpeed.updateValue(5);

		this.CoolingThresholdTemperature.updateValue(this.targetTemperature + 1);
		this.HeatingThresholdTemperature.updateValue(this.targetTemperature - 1);

		const mode = this._selectMode();
		this.aircon.setTemp(this.targetTemperature);
		if(mode === "COOL") this.aircon.setTemp(this.CoolingThresholdTemperature.value);
		if(mode === "HEAT") this.aircon.setTemp(this.HeatingThresholdTemperature.value);
		this.aircon.setMode(mode);
		this.aircon.setFan(this.defaultRotationSpeed);

	}

	updateDash() {
        if (!this.sensors.temperature) {
            this.CurrentTemperature.updateValue(this.targetTemperature);
        }

        if(this.sensors.eco2) {

        	this.CarbonDioxideLevelAQ.updateValue(this.CarbonDioxideLevel.value);

        	if(this.CarbonDioxideLevel.value > this.CarbonDioxidePeakLevel.value)
        		this.CarbonDioxidePeakLevel.updateValue(this.CarbonDioxideLevel.value);

        	if(this.CarbonDioxideLevel.value > 2000)
        		this.CarbonDioxideDetected.updateValue(Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL);
        	else
        		this.CarbonDioxideDetected.updateValue(Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL);
        }

		if (this.sensors.eco2 || this.sensors.tvoc) {
			const data = this._checkAirQuality();
			this.AirQuality.updateValue(data);
		}

		//Set compensation for co2 sensor
		if (this.sensors.humidity && this.sensors.temperature && this.sensors.eco2) {
			this.sensors.eco2.setCompensation(this.CurrentTemperature.value, this.CurrentRelativeHumidity.value);
		}

		let p1 = this.sensors.temperature && new Promise((resolve, reject) => {
			this.sensors.temperature.readTemperature()
				.then(data => this.CurrentTemperature.updateValue(data))
				.then(resolve)
				.catch(reject);
		});
		let p2 = this.sensors.humidity && new Promise((resolve, reject) => {
			this.sensors.humidity.readHumidity()
				.then(data => this.CurrentRelativeHumidity.updateValue(data))
				.then(resolve)
				.catch(reject);
		});
		let p3 = this.sensors.eco2 && this.sensors.tvoc && new Promise((resolve, reject) => {
			this.sensors.eco2.readSensorData()
				.then(data => {
// 					console.log(data);
					if(data > 3000) console.log("Warning!!! " + data);
					if(400 < data < 3000) {
						this.CarbonDioxideLevel.updateValue(data.eco2);
						this.VOCDensity.updateValue(data.tvoc);
					}
					else this.log.error("WARNING! WRONG DATA" + data); //for debug
				})
				.then(resolve)
				.catch(reject);
		});
		let p4 = this.sensors.airpressure && new Promise((resolve,reject) => {
			this.sensors.airpressure.readPressure()
				.then(data => this.CurrentAirPressure.updateValue(data))
				.then(resolve)
				.catch(reject);
		});


		Promise.all([p1,p2,p3,p4])
			.catch(err => this.log.error(err.message))
			.then(() => setTimeout(this.updateDash.bind(this), this.updateInterval));
	}

    sendCmdAsync() {

        clearTimeout(this.cmdHandle);
        this.cmdHandle = setTimeout(this._sendCmd.bind(this), this.cmdTimeout);

    }

    _sendCmd() {

/*
    	let active, mode, fan, swing, temp;

    	fan = this.RotationSpeed.value;

		mode = this.TargetHeaterCoolerState.value;
		temp = this.targetTemperature;


		if(this.SwingMode.value) swing = "SWING";
		else swing = "OFF";

*/
    	if(!this.Active.value) this.aircon.turnOff();

    	this.aircon.sendWave();

    }

	_setActive(Active, callback) {

		if(this.Active.value === Characteristic.Active.INACTIVE) this.aircon.turnOn();

        callback();

		this.debug('Calling setActive to ' + this.Active.value);

		this.sendCmdAsync();
    }

    _setTargetHeaterCoolerState(TargetHeaterCoolerState, callback) {
        callback();
    	this.debug('Calling setTargetHeaterCoolerState ' + this.TargetHeaterCoolerState.value);
    	this.debug(this.TargetHeaterCoolerState);

		let mode;

//         this.CurrentHeaterCoolerState.updateValue(TargetHeaterCoolerState + 1);
        /*
			Characteristic.CurrentHeaterCoolerState.INACTIVE = 0;
			Characteristic.CurrentHeaterCoolerState.IDLE = 1;
			Characteristic.CurrentHeaterCoolerState.HEATING = 2;
			Characteristic.CurrentHeaterCoolerState.COOLING = 3;

			Characteristic.TargetHeaterCoolerState.AUTO = 0;
			Characteristic.TargetHeaterCoolerState.HEAT = 1;
			Characteristic.TargetHeaterCoolerState.COOL = 2;
        */

		switch (this.TargetHeaterCoolerState.value) {
			case Characteristic.TargetHeaterCoolerState.AUTO:
// 				mode = "AUTO";
				mode = this._selectMode();
				break;
			case Characteristic.TargetHeaterCoolerState.COOL:
				mode = "COOL";
				this.CurrentHeaterCoolerState.updateValue(Characteristic.CurrentHeaterCoolerState.COOLING)
				break;
			case Characteristic.TargetHeaterCoolerState.HEAT:
				mode = "HEAT";
				this.CurrentHeaterCoolerState.updateValue(Characteristic.CurrentHeaterCoolerState.HEATING)
				break;
		}

    	this.aircon.setMode(mode);
        this.sendCmdAsync();

    }

	_setCoolingThresholdTemperature(CoolingThresholdTemperature, callback) {

		callback();

		this.debug('Calling CoolingThresholdTemperature to ' + this.CoolingThresholdTemperature.value);

//         if (this.CoolingThresholdTemperature.value !== CoolingThresholdTemperature.value) {
            this.targetTemperature = CoolingThresholdTemperature;
            this.aircon.setTemp(this.targetTemperature);
        	console.log('Cooling tres');
//         }

		this.sendCmdAsync();

	}

	_setHeatingThresholdTemperature(HeatingThresholdTemperature, callback) {

		callback();

		this.debug('Calling HeatingThresholdTemperature to ' + this.HeatingThresholdTemperature.value);

//         if (this.HeatingThresholdTemperature.value !== HeatingThresholdTemperature.value) {
            this.targetTemperature = HeatingThresholdTemperature;
            this.aircon.setTemp(this.targetTemperature);
        	console.log('Heating tres');
//         }


 		this.sendCmdAsync();

 	}

    _setSwingMode(SwingMode, callback) {

		callback();

		this.debug('Calling setSwingMode to ' + this.SwingMode.value);

    	let swing;

    	if(this.SwingMode.value) swing = "SWING";
		else swing = "OFF";
		this.aircon.setSwing(swing);

        this.sendCmdAsync();
    }

    _setRotationSpeed(RotationSpeed, callback) {

        callback();

    	let fan;
		switch (this.RotationSpeed.value) {
			case 1:
				fan = "QUIET";
				break;
			case 2:
				fan = "LOW";
				break;
			case 3:
				fan = "MED";
				break;
			case 4:
				fan = "HIGH";
				break;
			default:
				fan = "AUTO";
		}

        this.debug('Calling setRotationSpeed to ' + fan);

    	this.aircon.setFan(fan);
        this.sendCmdAsync();
	}

    _checkAirQuality() {

    	if(this.CarbonDioxideLevel.value > 2000) return Characteristic.AirQuality.POOR;
    	if(this.CarbonDioxideLevel.value > 1500) return Characteristic.AirQuality.INFERIOR;
    	if(this.CarbonDioxideLevel.value > 900) return Characteristic.AirQuality.FAIR;
    	if(this.CarbonDioxideLevel.value > 600) return Characteristic.AirQuality.GOOD;
    	return Characteristic.AirQuality.EXCELLENT

    }

    _selectMode() {
    	let mode;

		if(this.CurrentTemperature.value > this.CoolingThresholdTemperature.value) {
			this.CurrentHeaterCoolerState.updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
			return "COOL";
		}
		else if(this.CurrentTemperature.value < this.HeatingThresholdTemperature) {
			this.CurrentHeaterCoolerState.updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
			return "HEAT";
		}
		else {
			this.CurrentHeaterCoolerState.updateValue(Characteristic.CurrentHeaterCoolerState.COOLING);
			return "COOL";
		}

    }

}

