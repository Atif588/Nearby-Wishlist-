import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity,
  FlatList, Image, StyleSheet, Alert, ScrollView, Modal, ActivityIndicator
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { WebView } from 'react-native-webview';

const STORAGE_KEY = 'nearby_wishlist_places';

// Distance between two GPS points in km (haversine formula)
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Builds the Leaflet map HTML used inside the WebView "pin dropper"
function buildMapHtml(startLat, startLng) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map', { zoomControl: true }).setView([${startLat}, ${startLng}], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    function sendCenter() {
      const c = map.getCenter();
      window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat, lng: c.lng }));
    }
    map.on('moveend', sendCenter);
    // send initial center once map is ready
    setTimeout(sendCenter, 300);
  </script>
</body>
</html>`;
}

export default function App() {
  const [tab, setTab] = useState('nearby');
  const [places, setPlaces] = useState([]);

  // Add-place form state
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [image, setImage] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef(null);

  // Map pin-dropper state
  const [mapVisible, setMapVisible] = useState(false);
  const [pendingMapCenter, setPendingMapCenter] = useState(null);
  const [mapStart, setMapStart] = useState({ lat: 28.6139, lng: 77.2090 }); // Delhi default

  // Nearby tab state
  const [nearbyResults, setNearbyResults] = useState([]);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => { loadPlaces(); }, []);

  async function loadPlaces() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      setPlaces(raw ? JSON.parse(raw) : []);
    } catch (e) {
      console.error('Failed to load places', e);
    }
  }

  async function savePlacesToStorage(newPlaces) {
    setPlaces(newPlaces);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newPlaces));
    } catch (e) {
      console.error('Failed to save', e);
    }
  }

  async function useCurrentLocation() {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Location permission is required.');
      return;
    }
    const loc = await Location.getCurrentPositionAsync({});
    setLat(loc.coords.latitude.toFixed(6));
    setLng(loc.coords.longitude.toFixed(6));
  }

  async function pickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Photo library permission is required.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
      base64: false,
    });
    if (!result.canceled) {
      setImage(result.assets[0].uri);
    }
  }

  // --- Search (OpenStreetMap Nominatim, free, no API key) ---
  function onSearchChange(text) {
    setSearchQuery(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (text.trim().length < 3) {
      setSearchResults([]);
      return;
    }
    // Debounce so we don't hammer the free service on every keystroke
    searchTimeout.current = setTimeout(() => runSearch(text), 600);
  }

  async function runSearch(query) {
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6`;
      const res = await fetch(url, {
        headers: { 'Accept-Language': 'en' } // Nominatim usage policy: identify your app; fine for light personal use
      });
      const data = await res.json();
      setSearchResults(data);
    } catch (e) {
      console.error('Search failed', e);
      Alert.alert('Search failed', 'Could not reach the search service. Check your internet connection.');
    } finally {
      setSearching(false);
    }
  }

  function pickSearchResult(item) {
    setName(item.display_name.split(',')[0]);
    setLat(parseFloat(item.lat).toFixed(6));
    setLng(parseFloat(item.lon).toFixed(6));
    setSearchQuery('');
    setSearchResults([]);
  }

  // --- Map pin dropper ---
  async function openMapDropper() {
    // Try to center the map on the user's current location if available
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({});
        setMapStart({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      }
    } catch (e) {
      // fall back to default center silently
    }
    setPendingMapCenter(null);
    setMapVisible(true);
  }

  function onMapMessage(event) {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      setPendingMapCenter(data);
    } catch (e) {
      console.error('Bad message from map', e);
    }
  }

  function confirmMapPin() {
    if (!pendingMapCenter) {
      Alert.alert('Hold on', 'Move the map a little first so the pin location loads.');
      return;
    }
    setLat(pendingMapCenter.lat.toFixed(6));
    setLng(pendingMapCenter.lng.toFixed(6));
    setMapVisible(false);
  }

  function savePlace() {
    if (!name.trim()) {
      Alert.alert('Missing name', 'Please enter a place name.');
      return;
    }
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      Alert.alert('Missing location', 'Please set a location using search, the map, or "use current location".');
      return;
    }
    const newPlace = {
      id: Date.now().toString(),
      name: name.trim(),
      notes: notes.trim(),
      lat: latNum,
      lng: lngNum,
      image,
    };
    savePlacesToStorage([...places, newPlace]);
    setName(''); setNotes(''); setLat(''); setLng(''); setImage(null);
    Alert.alert('Saved', `"${newPlace.name}" added to your wishlist.`);
  }

  function deletePlace(id) {
    savePlacesToStorage(places.filter(p => p.id !== id));
  }

  async function checkNearby() {
    if (places.length === 0) {
      setStatusMsg('No saved places yet — add some first!');
      setNearbyResults([]);
      return;
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Location permission is required.');
      return;
    }
    setStatusMsg('Locating you...');
    const loc = await Location.getCurrentPositionAsync({});
    const { latitude, longitude } = loc.coords;

    const withDist = places
      .map(p => ({ ...p, distKm: distanceKm(latitude, longitude, p.lat, p.lng) }))
      .sort((a, b) => a.distKm - b.distKm);

    setNearbyResults(withDist);
    setStatusMsg(`You're at ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
  }

  function renderPlaceCard(item, distKm) {
    const near = distKm !== undefined && distKm <= 5;
    const distLabel = distKm === undefined
      ? null
      : distKm < 1 ? `${Math.round(distKm * 1000)} m away` : `${distKm.toFixed(1)} km away`;

    return (
      <View style={styles.card} key={item.id}>
        {item.image
          ? <Image source={{ uri: item.image }} style={styles.thumb} />
          : <View style={[styles.thumb, styles.thumbPlaceholder]} />}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          {!!item.notes && <Text style={styles.cardNotes}>{item.notes}</Text>}
          {distLabel && (
            <Text style={[styles.distBadge, near && styles.distBadgeNear]}>
              {near ? '🎯 Go check this out — ' : ''}{distLabel}
            </Text>
          )}
        </View>
        {tab === 'all' && (
          <TouchableOpacity onPress={() => deletePlace(item.id)} style={styles.deleteBtn}>
            <Text style={{ color: '#999', fontSize: 16 }}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>📍 Nearby Wishlist</Text>
        <Text style={styles.subtitle}>Save places you want to visit. Get nudged when you're close.</Text>
      </View>

      <View style={styles.tabs}>
        {['nearby', 'add', 'all'].map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'nearby' ? 'Nearby' : t === 'add' ? 'Add Place' : 'All Saved'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'nearby' && (
        <ScrollView style={styles.body}>
          <TouchableOpacity style={styles.primaryBtn} onPress={checkNearby}>
            <Text style={styles.primaryBtnText}>📡 Check what's near me</Text>
          </TouchableOpacity>
          {!!statusMsg && <Text style={styles.status}>{statusMsg}</Text>}
          {nearbyResults.map(p => renderPlaceCard(p, p.distKm))}
        </ScrollView>
      )}

      {tab === 'add' && (
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Search for a place</Text>
          <TextInput
            style={styles.input}
            value={searchQuery}
            onChangeText={onSearchChange}
            placeholder="Type a place name (e.g. a village, landmark)"
          />
          {searching && <ActivityIndicator style={{ marginTop: 8 }} color="#d4622a" />}
          {searchResults.map((item, idx) => (
            <TouchableOpacity key={idx} style={styles.resultRow} onPress={() => pickSearchResult(item)}>
              <Text style={styles.resultText} numberOfLines={2}>{item.display_name}</Text>
            </TouchableOpacity>
          ))}

          <Text style={styles.label}>Place name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Hauz Khas Village" />

          <Text style={styles.label}>Notes (optional)</Text>
          <TextInput style={[styles.input, { height: 60 }]} value={notes} onChangeText={setNotes} multiline placeholder="Why visit, what to do..." />

          <Text style={styles.label}>Location</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={[styles.input, { flex: 1 }]} value={lat} onChangeText={setLat} placeholder="Latitude" keyboardType="numeric" />
            <TextInput style={[styles.input, { flex: 1 }]} value={lng} onChangeText={setLng} placeholder="Longitude" keyboardType="numeric" />
          </View>

          <TouchableOpacity style={styles.ghostBtn} onPress={useCurrentLocation}>
            <Text style={styles.ghostBtnText}>📍 Use my current location</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.ghostBtn} onPress={openMapDropper}>
            <Text style={styles.ghostBtnText}>🗺️ Drop a pin on the map</Text>
          </TouchableOpacity>

          <Text style={styles.label}>Photo (optional)</Text>
          <TouchableOpacity style={styles.ghostBtn} onPress={pickImage}>
            <Text style={styles.ghostBtnText}>{image ? 'Change photo' : 'Pick a photo'}</Text>
          </TouchableOpacity>
          {image && <Image source={{ uri: image }} style={{ width: 70, height: 70, borderRadius: 10, marginTop: 8 }} />}

          <TouchableOpacity style={styles.primaryBtn} onPress={savePlace}>
            <Text style={styles.primaryBtnText}>Save Place</Text>
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {tab === 'all' && (
        <ScrollView style={styles.body}>
          {places.length === 0
            ? <Text style={styles.empty}>No places saved yet. Add one in the "Add Place" tab.</Text>
            : places.map(p => renderPlaceCard(p))}
        </ScrollView>
      )}

      {/* Map pin-dropper modal (Bykea-style) */}
      <Modal visible={mapVisible} animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: '#171614' }}>
          <View style={{ flex: 1 }}>
            <WebView
              source={{ html: buildMapHtml(mapStart.lat, mapStart.lng) }}
              onMessage={onMapMessage}
              style={{ flex: 1 }}
            />
            {/* Fixed pin overlay in the center of the screen */}
            <View pointerEvents="none" style={styles.pinOverlay}>
              <Text style={{ fontSize: 34 }}>📍</Text>
            </View>
          </View>
          <View style={styles.mapFooter}>
            <TouchableOpacity style={styles.mapCancelBtn} onPress={() => setMapVisible(false)}>
              <Text style={styles.mapCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.mapConfirmBtn} onPress={confirmMapPin}>
              <Text style={styles.primaryBtnText}>Confirm this spot</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f5f2' },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#1c1b19' },
  subtitle: { fontSize: 13, color: '#6b6862', marginTop: 2 },
  tabs: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: '#fff', borderRadius: 12, padding: 4, borderWidth: 1, borderColor: '#e6e3dd' },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: '#d4622a' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#6b6862' },
  tabTextActive: { color: '#fff' },
  body: { flex: 1, paddingHorizontal: 16, marginTop: 14 },
  label: { fontSize: 13, fontWeight: '600', color: '#6b6862', marginTop: 10, marginBottom: 5 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e3dd', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  resultRow: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e3dd', borderRadius: 10, padding: 10, marginTop: 6 },
  resultText: { fontSize: 13, color: '#1c1b19' },
  primaryBtn: { backgroundColor: '#d4622a', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  ghostBtn: { backgroundColor: '#fbe6d9', borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 8 },
  ghostBtnText: { color: '#d4622a', fontWeight: '600', fontSize: 14 },
  status: { textAlign: 'center', color: '#6b6862', fontSize: 13, marginVertical: 10 },
  empty: { textAlign: 'center', color: '#6b6862', fontSize: 14, marginTop: 40 },
  card: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 16, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#e6e3dd', alignItems: 'center' },
  thumb: { width: 60, height: 60, borderRadius: 12 },
  thumbPlaceholder: { backgroundColor: '#e6e3dd' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#1c1b19' },
  cardNotes: { fontSize: 13, color: '#6b6862', marginTop: 2 },
  distBadge: { fontSize: 12, fontWeight: '700', color: '#6b6862', backgroundColor: '#e6e3dd', alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20, marginTop: 6 },
  distBadgeNear: { backgroundColor: '#e3f3e6', color: '#3f7d4f' },
  deleteBtn: { padding: 6 },
  pinOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', marginBottom: 34,
  },
  mapFooter: { flexDirection: 'row', gap: 10, padding: 14, backgroundColor: '#171614' },
  mapCancelBtn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', backgroundColor: '#363228' },
  mapCancelText: { color: '#f2efe9', fontWeight: '600', fontSize: 15 },
  mapConfirmBtn: { flex: 2, borderRadius: 10, paddingVertical: 13, alignItems: 'center', backgroundColor: '#d4622a' },
});
