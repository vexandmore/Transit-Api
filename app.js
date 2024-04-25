"use strict"
import { closeDb, importGtfs, openDb, getStops, getStoptimes, getCalendars, getTrips, getRoutes } from 'gtfs';
import express from 'express';
import { PORT, config, defaultRadius, defaultMinutesInFuture } from './config.js';
import { getDistance, timeConversion } from 'geolib';

const app = express();

app.listen(PORT, () => {
    console.log("Server listening on PORT: ", PORT);
});

app.get("/status", (request, response) => {
    const status = {"status": "running"};
    response.send(status);
});

await importGtfs(config);
const db = openDb({});


function compareDepartureTimes(time1, time2) {
    time1 = String(time1);
    time2 = String(time2);
    var time1Components = [Number(time1.substring(0, 2)), Number(time1.substring(3, 5)), Number(time1.substring(6, 8))];
    var time2Components = [Number(time2.substring(0, 2)), Number(time2.substring(3, 5)), Number(time2.substring(6, 8))];
    for (let i = 0; i < 3; i++) {
        if (time1Components[i] < time2Components[i]) {return -1;}
        if (time1Components[i] > time2Components[i]) {return 1;}
    }
    return 0;
}

function addTimes(time1, time2) {
    time1 = String(time1);
    time2 = String(time2);
    var time1Components = [Number(time1.substring(0, 2)), Number(time1.substring(3, 5)), Number(time1.substring(6, 8))];
    var time2Components = [Number(time2.substring(0, 2)), Number(time2.substring(3, 5)), Number(time2.substring(6, 8))];
    for (let i = 0; i < 3; i++) {
        time1Components[i] += time2Components[i];
    }
    if (time1Components[2] > 59) {
        time1Components[1] += Math.floor(time1Components[2] / 60);
        time1Components[2] %= 60;
    }
    if (time1Components[1] > 59) {
        time1Components[0] += Math.floor(time1Components[1] / 60);
        time1Components[1] %= 60;
    }
    // Does not cap the first value, since timestamps can go to 24:00 and 25:00 in gtfs
    return ("0" + time1Components[0]).slice(-2)   + ":" + 
    ("0" + time1Components[1]).slice(-2) + ":" + 
    ("0" + time1Components[2]).slice(-2);
}

function nowString() {
    const now = new Date();
    const nowStr = ("0" + now.getHours()).slice(-2)   + ":" + 
                    ("0" + now.getMinutes()).slice(-2) + ":" + 
                    ("0" + now.getSeconds()).slice(-2);
    return nowStr;
}

function getCurrentServiceIds() {
    const calendarInfo = getCalendars();
    const currentDay = new Date().getDay();

    // Which service types are running today
    const currentServiceIds = [];
    for (const info of calendarInfo) {
        switch (currentDay) {
            case 0:
                if (info.sunday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 1:
                if (info.monday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 2:
                if (info.tuesday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 3:
                if (info.wednesday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 4:
                if (info.thursday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 5:
                if (info.friday === 1) {currentServiceIds.push(info.service_id);}
                break;
            case 6:
                if (info.saturday === 1) {currentServiceIds.push(info.service_id);}
                break;
        }
    }
    return currentServiceIds;
}

function makeCoord(stop) {
    return {latitude: stop.stop_lat, longitude: stop.stop_lon};
}

function getStopsNearUs(coords, radius) {
    var stops = getStops({}, ['stop_id', 'stop_lat', 'stop_lon', 'wheelchair_boarding']);
    const stopsInRadius = {};
    for (const stop of stops) {
        if (getDistance(coords, makeCoord(stop), 1) <= radius) {

            stopsInRadius[stop.stop_id] = {stop_lat: stop.stop_lat, stop_lon: stop.stop_lon};
        }
    }
    return stopsInRadius;
}

function getClosestStoptime(stopTimes, closeStops, coords) {
    if (stopTimes.length === 0)  {
        return null;
    }

    let min = stopTimes[0];
    let minDistance = getDistance(coords, makeCoord(closeStops[stopTimes[0].stop_id]));
    for (let i = 1; i < stopTimes.length; i++) {
        const currentDistance = getDistance(coords, makeCoord(closeStops[stopTimes[i].stop_id]));
        if (currentDistance < minDistance) {
            min = stopTimes[i];
            minDistance = currentDistance;
        }
    }
    return min;
}

app.get("/transit", (request, response) => {
    try {
        const coords = {longitude: Number(request.query.longitude), latitude: Number(request.query.latitude)};
        const radius = Number(request.query.radius || defaultRadius);
        const minutesInFuture = Number(request.query.minutesInFuture || defaultMinutesInFuture);
        
        const stopsInRadius = getStopsNearUs(coords, radius);
        const now = nowString();
        const maxTime = addTimes(now, "00:" + minutesInFuture + ":00");
        const stopTimes = [];
        
        // Get all stop times for all stops (ie every time a bus stops at a stop near us)
        for (const stop_id in stopsInRadius) {
            if (Object.prototype.hasOwnProperty.call(stopsInRadius, stop_id)) {
                // Only loop over the properties not in the prototype (ie only the stop ids added to it)
                stopTimes.push(...getStoptimes({stop_id: stop_id}, ['stop_id', 'trip_id', 'arrival_time', 'departure_time', 'pickup_type']));
            }
        }
        
        // Filter to keep upcoming departures, that are within the max time
        // (tested to be faster than filtering at the end)
        const stopTimesInWindow = stopTimes.filter((stopTime) => {
            return compareDepartureTimes(stopTime.departure_time, maxTime) <= 0 &&
            compareDepartureTimes(stopTime.departure_time, now) >= 0;
        });

        // Deduplicate stops (if one bus line stops at many stops in radius, only keep closest)
        // Sort by trip_id to keep easier, since duplicates will have same trip_id
        const deduplicatedStops = [];
        stopTimesInWindow.sort((a, b) => {
            return a.trip_id.localeCompare(b.trip_id);
        });

        for (let i = 0; i < stopTimesInWindow.length; i++) {
            if (i === stopTimesInWindow.length - 1) {
                deduplicatedStops.push(stopTimesInWindow[i]);
                break;
            }

            if (stopTimesInWindow[i].trip_id === stopTimesInWindow[i + 1].trip_id) {
                let lastIndex = i;
                for (; lastIndex < stopTimesInWindow.length - 1; lastIndex++) {
                    if (stopTimesInWindow[lastIndex].trip_id !== stopTimesInWindow[lastIndex + 1].trip_id) {
                        break;
                    }
                }
                const duplicates = stopTimesInWindow.slice(i, lastIndex + 1);

                const closest = getClosestStoptime(duplicates, stopsInRadius, coords);
                deduplicatedStops.push(closest);
                i = lastIndex; // the i++ will increment it past the last index
            } else {
                deduplicatedStops.push(stopTimesInWindow[i]);
            }
        }

        const currentServiceIds = getCurrentServiceIds();
        const todayStoptimes = [];

        // Get only stoptimes for today that allow pickup and add bus line
        for (const stop of deduplicatedStops) {
            if (stop.pickup_type !== 0 && stop.pickup_type !== null) {
                continue;
            }
            const trips = getTrips({trip_id: stop.trip_id});
            if (trips.length === 1) {
                const trip = trips[0];
                if (currentServiceIds.includes(trip.service_id)) {
                    stop.trip_headsign = trip.trip_headsign;
                    stop.wheelchair_accessible = trip.wheelchair_accessible;
                    const route = getRoutes({route_id: trip.route_id}, ['route_short_name', 'route_color', 'route_text_color'])[0];
                    stop.route_short_name = route.route_short_name;
                    stop.route_color = route.route_color;
                    stop.route_text_color = route.route_text_color;
                    todayStoptimes.push(stop);
                } else {
                    console.log();
                }
            } else {
                console.log();
            }
        }
        
        // Sort based on departure time
        todayStoptimes.sort((a, b) => {
            return compareDepartureTimes(a.departure_time, b.departure_time);
        });
        response.set("Access-Control-Allow-Origin", "*");
        response.status(200).json({ stopTimes: todayStoptimes });
    } catch(error) {
        response.status(500).send(error.toString());
    }
});
