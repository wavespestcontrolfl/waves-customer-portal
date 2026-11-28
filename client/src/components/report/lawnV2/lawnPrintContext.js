import { createContext } from 'react';

// Shared static/PDF print context for Lawn V2 components — kept in a tiny module
// so ReportViewPage can wrap lazy lawn chunks without pulling in all of LawnReportV2.
export const PrintContext = createContext(false);
