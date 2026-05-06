import { useEffect, useRef } from 'react';

const SWFL_BOUNDS = {
  north: 27.95,
  south: 26.75,
  east: -81.75,
  west: -83.05,
};

/**
 * Google Places address autocomplete input.
 *
 * Props:
 *   value       — controlled input string
 *   onChange    — (value) => void  (fires on typing)
 *   onSelect    — (parts) => void  (fires when user picks a suggestion)
 *                 parts: { formatted, line1, city, state, zip, lat, lng }
 *   placeholder
 *   autoFocus
 *   style       — inline style overrides for the input
 *   country     — default 'us'
 */
export default function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = '123 Main St',
  autoFocus = false,
  className,
  style,
  country = 'us',
}) {
  const inputRef = useRef(null);
  const acRef = useRef(null);
  const lastSelectedRef = useRef('');

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';
    if (!apiKey) return;

    // Dropdown styles — light theme, match the booking page
    if (!document.getElementById('pac-light-style')) {
      const style = document.createElement('style');
      style.id = 'pac-light-style';
      style.textContent = `
        .pac-container { background: #FFFFFF !important; border: 1px solid #D4D2CC !important; border-radius: 8px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'DM Sans', sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.12) !important; }
        .pac-item { padding: 10px 14px !important; border-top: 1px solid #EDECE8 !important; color: #5C5B56 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #E8F8F9 !important; }
        .pac-item-query { color: #0B2545 !important; font-weight: 600 !important; }
        .pac-matched { color: #0FA3B1 !important; font-weight: 700 !important; }
        .pac-icon { display: none !important; }
        .pac-logo::after { display: none !important; }
      `;
      document.head.appendChild(style);
    }

    function init() {
      if (!window.google?.maps?.places || !inputRef.current || acRef.current) return false;
      const ac = new window.google.maps.places.Autocomplete(inputRef.current, {
        types: ['address'],
        componentRestrictions: { country },
        bounds: SWFL_BOUNDS,
        strictBounds: false,
        fields: ['formatted_address', 'address_components', 'geometry'],
      });
      ac.addListener('place_changed', () => {
        const p = ac.getPlace();
        if (!p || !p.address_components) return;
        const get = (type) => {
          const c = p.address_components.find(c => c.types.includes(type));
          return c ? c.long_name : '';
        };
        const getShort = (type) => {
          const c = p.address_components.find(c => c.types.includes(type));
          return c ? c.short_name : '';
        };
        const streetNum = get('street_number');
        const route = get('route');
        const line1 = [streetNum, route].filter(Boolean).join(' ');
        const parts = {
          formatted: p.formatted_address || '',
          line1,
          city: get('locality') || get('sublocality') || get('postal_town'),
          state: getShort('administrative_area_level_1'),
          zip: get('postal_code'),
          lat: p.geometry?.location?.lat?.() ?? null,
          lng: p.geometry?.location?.lng?.() ?? null,
        };
        if (parts.state && parts.state !== 'FL') return;
        lastSelectedRef.current = parts.formatted || parts.line1 || '';
        onSelect?.(parts);
      });
      acRef.current = ac;
      return true;
    }

    if (init()) return;

    // Script already loading? poll.
    if (document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) {
      const iv = setInterval(() => { if (init()) clearInterval(iv); }, 250);
      setTimeout(() => clearInterval(iv), 8000);
      return () => clearInterval(iv);
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const iv = setInterval(() => { if (init()) clearInterval(iv); }, 200);
      setTimeout(() => clearInterval(iv), 8000);
    };
    document.head.appendChild(script);
  }, [country, onSelect]);

  return (
    <input
      ref={inputRef}
      type="text"
      autoFocus={autoFocus}
      className={className}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={() => {
        const typed = (inputRef.current?.value || '').trim();
        if (!typed || typed === lastSelectedRef.current || !window.google?.maps?.Geocoder) return;
        const geocoder = new window.google.maps.Geocoder();
        geocoder.geocode({
          address: typed,
          bounds: SWFL_BOUNDS,
          componentRestrictions: { country, administrativeArea: 'FL' },
        }, (results, status) => {
          if (status !== 'OK' || !results?.[0]) return;
          const p = results[0];
          const get = (type) => {
            const c = p.address_components?.find(c => c.types.includes(type));
            return c ? c.long_name : '';
          };
          const getShort = (type) => {
            const c = p.address_components?.find(c => c.types.includes(type));
            return c ? c.short_name : '';
          };
          const line1 = [get('street_number'), get('route')].filter(Boolean).join(' ');
          const parts = {
            formatted: p.formatted_address || typed,
            line1,
            city: get('locality') || get('sublocality') || get('postal_town'),
            state: getShort('administrative_area_level_1'),
            zip: get('postal_code'),
            lat: p.geometry?.location?.lat?.() ?? null,
            lng: p.geometry?.location?.lng?.() ?? null,
          };
          if (parts.state && parts.state !== 'FL') return;
          lastSelectedRef.current = parts.formatted || parts.line1 || typed;
          onSelect?.(parts);
        });
      }}
      style={style}
    />
  );
}
