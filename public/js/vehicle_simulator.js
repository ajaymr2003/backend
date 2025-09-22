// /backend/public/js/vehicle_simulator.js

const apiUrl = '/api';
let userEmail = null;

// --- State Variables ---
let statusInterval = null;
let navigationPollInterval = null; // Separate interval for checking navigation requests
let animationInterval = null;
let locationUpdateInterval = null;
let currentIndex = 0;
let arrivalAlertShown = false; // Flag to prevent repeated alerts

// --- Map Layers ---
let map = null;
let userMarker = null;
let destinationMarker = null;
let vehicleMarker = null;
let routeLine = null;
let routeData = null;

const defaultCenter = [12.9716, 77.5946];

// --- Get all UI elements ---
const userSelect = document.getElementById('userSelect');
const batteryLevelInput = document.getElementById('batteryLevelInput');
const setBatteryButton = document.getElementById('setBatteryButton');
const drainRateSelect = document.getElementById('drainRateSelect');
const vehicleSpeedSelect = document.getElementById('vehicleSpeedSelect');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const mapInstruction = document.getElementById('mapInstruction');
const currentUserElem = document.getElementById('currentUser');
const runningStatusElem = document.getElementById('runningStatus');
const batteryLevelElem = document.getElementById('batteryLevel');
const routeInfoElem = document.getElementById('routeInfo');
const routeDistanceElem = document.getElementById('routeDistance');
const routeTimeElem = document.getElementById('routeTime');


// --- Event Listeners ---
userSelect.addEventListener('change', () => {
    userEmail = userSelect.value;
    if (userEmail) {
        resetUIAndState();
        currentUserElem.textContent = userEmail;
        resetButton.disabled = false;
        
        // Start both status polling and the new navigation polling
        startPolling(true); 
        startNavigationPolling(); 
    }
});
setBatteryButton.addEventListener('click', () => {
    if (!userEmail) {
        alert("Please select a user first.");
        return;
    }
    const batteryLevel = parseInt(batteryLevelInput.value, 10);
    if (batteryLevel < 1 || batteryLevel > 100) {
        alert("Please enter a battery level between 1 and 100.");
        return;
    }
    callApi('/update-battery', { email: userEmail, batteryLevel });
});
startButton.addEventListener('click', async () => {
    if (!routeData) {
        alert("Please set a valid start and destination point on the map.");
        return;
    }
    stopNavigationPolling(); // Manually starting overrides navigation listening
    await startRide();
});
stopButton.addEventListener('click', () => {
    callApi('/stop', { email: userEmail });
    stopMovementSimulation();
});
resetButton.addEventListener('click', () => {
    callApi('/reset', { email: userEmail });
    resetSimulationState();
});
vehicleSpeedSelect.addEventListener('change', () => {
    displayRouteInfo();
    if (animationInterval) {
        scheduleAnimation();
    }
});
drainRateSelect.addEventListener('change', () => {
    if (userEmail && runningStatusElem.classList.contains('running')) {
        callApi('/update-drain-rate', {
            email: userEmail,
            drainRate: drainRateSelect.value
        });
    }
});


// --- NEW/MODIFIED Core Functions ---

// Continuously poll for navigation requests.
function startNavigationPolling() {
    stopNavigationPolling(); // Ensure no multiple pollers are running
    if (!userEmail) return;

    console.log(`Starting navigation polling for ${userEmail}.`);
    mapInstruction.innerHTML = "Listening for remote navigation request... or set a route manually.";

    navigationPollInterval = setInterval(async () => {
        // Only check if the simulation is NOT currently running
        if (!runningStatusElem.classList.contains('running')) {
            const res = await fetch(`${apiUrl}/navigation-status?email=${encodeURIComponent(userEmail)}`);
            const navData = await res.json();
            if (navData && navData.isNavigating === true) {
                console.log("Remote navigation request detected!");
                stopNavigationPolling(); // Stop polling once a request is found
                await handleRemoteNavigation(navData);
            }
        } else {
             // If simulation started, stop polling.
            stopNavigationPolling();
        }
    }, 4000); // Check every 4 seconds
}

// Stop the navigation polling.
function stopNavigationPolling() {
    if (navigationPollInterval) {
        console.log("Stopping navigation polling.");
        clearInterval(navigationPollInterval);
        navigationPollInterval = null;
    }
}

// Logic to process the detected navigation request.
async function handleRemoteNavigation(navData) {
    mapInstruction.innerHTML = "<strong>Remote navigation detected!</strong> Setting route...";
    
    const startLatLng = L.latLng(navData.start_lat, navData.start_lng);
    const endLatLng = L.latLng(navData.end_lat, navData.end_lng);

    createOrUpdateStartMarker(startLatLng);
    createOrUpdateDestinationMarker(endLatLng);

    routeData = await fetchRoute(startLatLng, endLatLng);

    if (routeData) {
        await startRide();
        // Do not call end-navigation here; let the arrival detection handle it.
    } else {
        alert("Remote navigation failed: Could not calculate a route.");
        startNavigationPolling(); // Resume listening if route fails
    }
}

// Centralized function to start the ride simulation.
async function startRide() {
    arrivalAlertShown = false; // Reset flag on new ride
    await callApi('/start', {
        email: userEmail,
        initialBattery: batteryLevelInput.value,
        drainRate: drainRateSelect.value
    });
    startMovementSimulation();
}

function resetUIAndState() {
    stopPolling();
    stopNavigationPolling();
    if (animationInterval) clearInterval(animationInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);

    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (vehicleMarker) { vehicleMarker.remove(); vehicleMarker = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    
    routeData = null;
    currentIndex = 0;
    arrivalAlertShown = false; // Reset flag when user changes
    routeInfoElem.style.display = 'none';
    updateControlsState(false);
}

// --- Existing Core Functions ---
function updateControlsState(isRunning) {
    userSelect.disabled = isRunning;
    batteryLevelInput.disabled = isRunning;
    setBatteryButton.disabled = isRunning;
    drainRateSelect.disabled = false;
    vehicleSpeedSelect.disabled = false;
    resetButton.disabled = isRunning;
    startButton.disabled = isRunning || !routeData;
    stopButton.disabled = !isRunning;
}
async function fetchRoute(startLatLng, endLatLng) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?geometries=geojson`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OSRM responded with status ${response.status}`);
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            return {
                coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                distance: route.distance
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching route from OSRM:", error);
        return null;
    }
}
function displayRouteInfo() {
    if (!routeData) return;
    const distanceKm = (routeData.distance / 1000).toFixed(2);
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const timeHours = speedKmh > 0 ? distanceKm / speedKmh : 0;
    const timeMinutes = Math.round(timeHours * 60);
    routeDistanceElem.textContent = distanceKm;
    routeTimeElem.textContent = `${timeMinutes} min`;
    routeInfoElem.style.display = 'block';
}
function scheduleAnimation() {
    if (animationInterval) clearInterval(animationInterval);
    const routeCoordinates = routeData.coordinates;
    const distanceMeters = routeData.distance;
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const speedMps = speedKmh * 1000 / 3600;
    const totalDurationSeconds = speedKmh > 0 ? distanceMeters / speedMps : Infinity;
    const stepInterval = (totalDurationSeconds / routeCoordinates.length) * 1000;

    animationInterval = setInterval(() => {
        if (currentIndex >= routeCoordinates.length) {
            // Let the backend handle the arrival detection instead of stopping here
            return;
        }
        if (vehicleMarker) {
            vehicleMarker.setLatLng(routeCoordinates[currentIndex]);
        }
        currentIndex++;
    }, stepInterval);
}
function startMovementSimulation() {
    stopNavigationPolling(); // Make sure listening stops when simulation runs
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) routeLine.remove();
    
    currentIndex = 0;
    const routeCoordinates = routeData.coordinates;
    routeLine = L.polyline(routeCoordinates, { color: '#007bff', weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });

    displayRouteInfo();

    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3039/3039898.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    vehicleMarker = L.marker(routeCoordinates[0], { icon: carIcon }).addTo(map);
    scheduleAnimation();
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    locationUpdateInterval = setInterval(() => {
        if (vehicleMarker) {
            const { lat, lng } = vehicleMarker.getLatLng();
            updateVehicleLocation(lat, lng);
        }
    }, 1500);
}
async function onMapClick(e) {
    if (!userEmail) { alert("Please select a user first."); return; }
    if (runningStatusElem.classList.contains('running')) return;
    stopNavigationPolling(); // Manual interaction stops listening
    const { lat, lng } = e.latlng;
    if (!userMarker) {
        createOrUpdateStartMarker([lat, lng]);
        updateVehicleLocation(lat, lng);
        mapInstruction.innerHTML = "Click map to set the <strong>Destination Point</strong>.";
    } else {
        createOrUpdateDestinationMarker([lat, lng]);
        if (routeLine) { routeLine.remove(); routeLine = null; }
        routeData = await fetchRoute(userMarker.getLatLng(), destinationMarker.getLatLng());
        if (routeData) {
            routeLine = L.polyline(routeData.coordinates, { color: '#007bff', weight: 5, dashArray: '10, 5' }).addTo(map);
            map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
            displayRouteInfo();
            mapInstruction.innerHTML = "Route is set. You can now <strong>Start Ride</strong>.";
        } else {
            routeInfoElem.style.display = 'none';
            if(destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
            mapInstruction.innerHTML = "Could not find a route. Please set a new <strong>Destination Point</strong>.";
        }
    }
    updateControlsState(false);
}
function resetSimulationState() {
    stopMovementSimulation();
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    routeData = null;
    arrivalAlertShown = false; // Reset flag on full reset
    routeInfoElem.style.display = 'none';
    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
    getStatus();
    startNavigationPolling(); // Resume listening after a reset
}
const getStatus = (isInitialSetup = false) => {
    if (!userEmail) return;
    fetch(`${apiUrl}/status?email=${encodeURIComponent(userEmail)}`)
        .then(res => res.json())
        .then(data => {
            const isRunning = data.isRunning;
            runningStatusElem.textContent = isRunning ? 'Running' : 'Not Running';
            runningStatusElem.className = isRunning ? 'running' : 'stopped';
            batteryLevelElem.textContent = `${data.batteryLevel} %`;
            batteryLevelInput.value = data.batteryLevel; // <-- THIS IS THE FIX

            // Check for the arrival flag AND the local alert flag
            if (data.arrivalCompleted && !arrivalAlertShown) {
                arrivalAlertShown = true; // Set flag immediately to prevent loop
                alert("Vehicle has arrived at the destination station!");
                mapInstruction.innerHTML = `<strong>Vehicle has arrived at the destination station!</strong> Ready for next command.`;
                // Acknowledge the arrival and clear the navigation state on the server
                callApi('/end-navigation', { email: userEmail });
            }

            updateControlsState(isRunning);

            if (!isRunning && vehicleMarker) {
                stopMovementSimulation();
            }
            if (isInitialSetup) {
                if (data.latitude != null && data.longitude != null) {
                    const vehiclePosition = [data.latitude, data.longitude];
                    createOrUpdateStartMarker(vehiclePosition);
                    map.setView(vehiclePosition, 15);
                }
            }
        })
        .catch(console.error);
};
function startPolling(isInitial = false) {
    stopPolling();
    getStatus(isInitial); 
    statusInterval = setInterval(() => getStatus(false), 2000);
}
function stopPolling() {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = null;
}
function stopMovementSimulation() {
    if (animationInterval) clearInterval(animationInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    animationInterval = null;
    locationUpdateInterval = null;
    currentIndex = 0;
    if (vehicleMarker) {
        const lastPosition = vehicleMarker.getLatLng();
        vehicleMarker.remove();
        vehicleMarker = null;
        createOrUpdateStartMarker(lastPosition);
    }
    getStatus();
    startNavigationPolling(); // IMPORTANT: Resume listening for navigation requests after a ride ends.
}
function initMap() {
    map = L.map('map').setView(defaultCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    map.on('click', onMapClick);
}
function createOrUpdateStartMarker(latlng) {
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/6274/6274953.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    if (userMarker) {
        userMarker.setLatLng(latlng);
    } else {
        userMarker = L.marker(latlng, { icon: carIcon, draggable: true }).addTo(map);
        userMarker.on('dragend', async (event) => {
            if (runningStatusElem.classList.contains('running')) return;
            if (destinationMarker) {
                onMapClick({ latlng: destinationMarker.getLatLng() });
            }
        });
    }
}
function createOrUpdateDestinationMarker(latlng) {
    const flagIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/157/157233.png',
        iconSize: [38, 38], iconAnchor: [1, 38]
    });
    if (destinationMarker) {
        destinationMarker.setLatLng(latlng);
    } else {
        destinationMarker = L.marker(latlng, { icon: flagIcon, draggable: true }).addTo(map);
        destinationMarker.on('dragend', (event) => {
            onMapClick({ latlng: event.target.getLatLng() });
        });
    }
}
async function callApi(endpoint, body) {
    try {
        const response = await fetch(apiUrl + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `API call to ${endpoint} failed`);
        }
        const data = await response.json();
        console.log(`API call to ${endpoint} successful:`, data);
        if (endpoint !== '/start') {
             getStatus();
        }
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error);
        alert(`Error: ${error.message}`);
    }
}
async function fetchAndDisplayStations() {
    try {
        const res = await fetch(`${apiUrl}/stations`);
        const data = await res.json();
        const stations = Array.isArray(data.stations) ? data.stations : [];
        const stationIcon = L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448603.png',
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        });
        const stationPositions = [];
        stations.forEach(station => {
            if (station.latitude && station.longitude) {
                const position = [station.latitude, station.longitude];
                L.marker(position, { icon: stationIcon })
                    .addTo(map)
                    .bindPopup(`<b>${station.name}</b>`);
                stationPositions.push(position);
            }
        });
        if (stationPositions.length > 0) {
            const bounds = L.latLngBounds(stationPositions);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    } catch (error) {
        console.error('Failed to load stations for map:', error);
    }
}
async function updateVehicleLocation(latitude, longitude) {
    if (!userEmail) return;
    await callApi('/update-location', {
        email: userEmail,
        latitude,
        longitude
    });
}
async function initialize() {
    initMap();
    await fetchAndDisplayStations();
    try {
        const userRes = await fetch(`${apiUrl}/users`);
        const userData = await userRes.json();
        userSelect.innerHTML = '<option value="" disabled selected>Select a User</option>';
        (userData.users || []).forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            option.textContent = email;
            userSelect.appendChild(option);
        });
        if (userData.users && userData.users.length > 0) {
            userSelect.value = userData.users[0];
            userSelect.dispatchEvent(new Event('change'));
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
    mapInstruction.innerHTML = "Select a user to begin.";
    updateControlsState(false);
}
initialize();