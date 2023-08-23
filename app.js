"use strict"
import { closeDb, importGtfs, openDb, getStops, getStoptimes, getCalendars, getTrips } from 'gtfs';
import express from 'express';
import {PORT, config} from './config.js';

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

app.get("/transit", (request, response) => {
    try {
        const stoptimes = getStoptimes({stop_id: Number(request.query.stop_id)}, ['trip_id', 'arrival_time', 'departure_time', 'pickup_type']);
        const todayStoptimes = [];
        const currentServiceIds = getCurrentServiceIds();
        
        // Get only stoptimes for today and those that allow pickup
        for (const stop of stoptimes) {
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
        
        // Sort based on departure time
        todayStoptimes.sort((a, b) => {
            return compareDepartureTimes(a.departure_time, b.departure_time);
        });

        // Get ones after now
        const now = nowString();
        const upcomingTimes = todayStoptimes.filter((a) => compareDepartureTimes(a.departure_time, now) >= 0);

        response.status(200).json({ stopTimes: upcomingTimes });
    } catch(error) {
        response.status(500).send(error.toString());
    }
});
