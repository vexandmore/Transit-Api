"use strict"
import { closeDb, importGtfs, openDb, getStops, getStoptimes, getCalendars, getTrips } from 'gtfs';
import express from 'express';
import {PORT, config} from './config.js';
import { getDistance } from 'geolib';

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
        const radius = Number(request.query.radius);
        const stopsInRadius = getStopsNearUs(coords, radius);

        const stopTimes = [];
        for (const stop_id in stopsInRadius) {
            if (Object.prototype.hasOwnProperty.call(stopsInRadius, stop_id)) {
                // Only loop over the properties not in the prototype (ie only the stop ids added to it)
                stopTimes.push(...getStoptimes({stop_id: stop_id}, ['stop_id', 'trip_id', 'arrival_time', 'departure_time', 'pickup_type']));
            }
        }

        // Deduplicate stops (if one bus line stops at many stops in radius, only keep closest)
        // Sort by trip_id to keep easier, since duplicates will have same trip_id
        const deduplicatedStops = [];
        stopTimes.sort((a, b) => {
            return a.trip_id.localeCompare(b.trip_id);
        });

        for (let i = 0; i < stopTimes.length; i++) {
            if (i === stopTimes.length - 1) {
                deduplicatedStops.push(stopTimes[i]);
                break;
            }

            if (stopTimes[i].trip_id === stopTimes[i + 1].trip_id) {
                let lastIndex = i;
                for (; lastIndex < stopTimes.length - 1; lastIndex++) {
                    try {
                        if (stopTimes[lastIndex].trip_id !== stopTimes[lastIndex + 1].trip_id) {
                            break;
                        }
                    } catch (e) {
                        console.log("lol");
                    }
                }
                const duplicates = stopTimes.slice(i, lastIndex + 1);

                const closest = getClosestStoptime(duplicates, stopsInRadius, coords);
                deduplicatedStops.push(closest);
                i = lastIndex; // the i++ will increment it past the last index
            } else {
                deduplicatedStops.push(stopTimes[i]);
            }
        }

        const currentServiceIds = getCurrentServiceIds();
        const todayStoptimes = [];

        // Get only stoptimes for today that allow pickup
        for (const stop of deduplicatedStops) {
            if (stop.pickup_type !== 0) {
                break;
            }
            const trips = getTrips({trip_id: stop.trip_id});
            if (trips.length === 1) {
                const trip = trips[0];
                for (const currentServiceId of currentServiceIds) {
                    if (currentServiceId === trip.service_id) {
                        stop.trip_headsign = trip.trip_headsign;
                        stop.wheelchair_accessible = trip.wheelchair_accessible;
                        todayStoptimes.push(stop);
                    }
                }    
            }
        }
        
        // Get ones after now
        const now = nowString();
        const upcomingTimes = todayStoptimes.filter((a) => compareDepartureTimes(a.departure_time, now) >= 0);
                
        // Sort based on departure time
        upcomingTimes.sort((a, b) => {
            return compareDepartureTimes(a.departure_time, b.departure_time);
        });


        response.status(200).json({ stopTimes: upcomingTimes });
    } catch(error) {
        response.status(500).send(error.toString());
    }
});
