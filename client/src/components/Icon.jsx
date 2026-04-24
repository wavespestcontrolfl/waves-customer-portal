// Centralized icon wrapper — one import across the customer portal so the
// whole surface switches icon libraries in one file if the brand ever moves
// off lucide. Icons inherit `currentColor` and scale with font-size, so
// callers control appearance via parent styles.
import {
  AlertCircle, AlertTriangle, ArrowRight, ArrowUp, Award,
  BarChart3, Bell, Bot, Brain, Bug, Building2,
  Calendar, Camera, Check, CheckCircle2, ChevronDown,
  ChevronRight, ClipboardList, Clock, Cloud, CloudLightning,
  CloudRain, Coins, CreditCard, DollarSign, DoorClosed,
  Droplets, Eye, EyeOff, FileEdit, FileText,
  Fish, Flame, FlaskConical, Frown, Gift,
  Hammer, Hand, Home, Key, Leaf,
  LifeBuoy, Lightbulb, Lock, Mail, Map,
  Medal, Megaphone, MessageCircle, MessageSquare, Microscope,
  MoreHorizontal, Mouse, Newspaper, Palmtree, Paperclip,
  PartyPopper, PawPrint, Pencil, Phone, Plus,
  RefreshCw, Rocket, Ruler, Search, Share2,
  Shield, ShieldCheck, Smartphone, Sparkles, Sprout,
  Star, Sun, Thermometer, Tornado, TreePine,
  TrendingUp, Trophy, Truck, Unlock, Upload,
  Waves, Wrench, X, Zap,
} from 'lucide-react';

// name → component. Emoji keys are the ones used in the old portal so a
// sweep could migrate `{'🏠'}` → `<Icon name="home" />` deterministically.
const MAP = {
  // Navigation + core UI
  home: Home,
  plan: ShieldCheck,
  shield: Shield,
  visits: Calendar,
  calendar: Calendar,
  billing: CreditCard,
  card: CreditCard,
  refer: Gift,
  gift: Gift,
  documents: FileText,
  document: FileText,
  property: Home,
  house: Home,
  learn: Lightbulb,
  bulb: Lightbulb,
  more: MoreHorizontal,
  close: X,
  x: X,
  check: Check,
  checkCircle: CheckCircle2,
  plus: Plus,
  search: Search,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  upgrade: ArrowUp,
  eye: Eye,
  eyeOff: EyeOff,
  refresh: RefreshCw,
  share: Share2,
  upload: Upload,
  download: Upload, // visually same; lucide "Download" exists but Upload suits share/send intents
  clock: Clock,
  bell: Bell,

  // Contact + comms
  phone: Phone,
  mail: Mail,
  chat: MessageCircle,
  message: MessageSquare,
  bot: Bot,
  hand: Hand,
  wave: Hand,
  megaphone: Megaphone,

  // Money + billing
  coins: Coins,
  money: DollarSign,
  dollar: DollarSign,

  // Security
  lock: Lock,
  unlock: Unlock,
  key: Key,

  // Achievement
  star: Star,
  trophy: Trophy,
  medal: Medal,
  award: Award,
  sparkles: Sparkles,
  party: PartyPopper,
  rocket: Rocket,

  // Alerts
  alert: AlertCircle,
  warning: AlertTriangle,
  sos: LifeBuoy,

  // Charts + data
  chart: BarChart3,
  trend: TrendingUp,
  ruler: Ruler,
  microscope: Microscope,
  flask: FlaskConical,
  brain: Brain,

  // Tools
  wrench: Wrench,
  hammer: Hammer,
  tools: Wrench,
  zap: Zap,
  flame: Flame,

  // Nature + pest control
  waves: Waves,
  leaf: Leaf,
  sprout: Sprout,
  tree: TreePine,
  palm: Palmtree,
  thermometer: Thermometer,
  droplet: Droplets,
  water: Droplets,
  sun: Sun,
  cloud: Cloud,
  cloudRain: CloudRain,
  cloudLightning: CloudLightning,
  tornado: Tornado,
  bug: Bug,
  mouse: Mouse,
  fish: Fish,
  paw: PawPrint,

  // Places
  truck: Truck,
  door: DoorClosed,
  building: Building2,
  map: Map,

  // Document + capture
  camera: Camera,
  clipboard: ClipboardList,
  paperclip: Paperclip,
  pencil: Pencil,
  edit: FileEdit,
  newspaper: Newspaper,
  smartphone: Smartphone,

  // Misc
  frown: Frown,
};

export default function Icon({ name, size = 16, strokeWidth = 2, style, className, ...rest }) {
  const Cmp = MAP[name];
  if (!Cmp) return null;
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
      aria-hidden="true"
      {...rest}
    />
  );
}
