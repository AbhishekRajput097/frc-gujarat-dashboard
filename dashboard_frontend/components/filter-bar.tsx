"use client";

import { useDataStore } from "@/lib/data-store";
import { ACADEMIC_YEARS, BOARDS, MEDIUMS, STANDARDS, STANDARD_GROUPS } from "@/lib/constants";
import { applyFilters } from "@/lib/data-utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MapPin, GraduationCap } from "lucide-react";

export function FilterBar() {
  const { fees, districts, filters, setFilters, latestYear } = useDataStore();

  // Calculate matching schools count
  const matchingFees = applyFilters(fees, filters, filters.academicYear);
  const schoolCount = new Set(matchingFees.map(f => f.school_key)).size;

  return (
    <div className="sticky top-14 z-30 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="mx-auto max-w-[1400px] px-4 py-3 md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* Filter controls */}
          <div className="flex flex-wrap items-center gap-3 md:flex-nowrap md:justify-start md:gap-4">
            {/* District selector */}
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <Select
                value={filters.district}
                onValueChange={(value) => setFilters({ district: value })}
              >
                <SelectTrigger className="w-44 bg-input">
                  <SelectValue placeholder="Select district" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All Gujarat">All Gujarat</SelectItem>
                  {districts.map((district) => (
                    <SelectItem key={district} value={district}>
                      {district}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Board selector - pill buttons */}
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              {BOARDS.map((board) => (
                <Button
                  key={board}
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilters({ board })}
                  className={cn(
                    "h-7 px-3 text-xs font-medium",
                    filters.board === board
                      ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {board}
                </Button>
              ))}
            </div>

            {/* Medium selector - pill buttons */}
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              {MEDIUMS.map((medium) => (
                <Button
                  key={medium}
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilters({ medium })}
                  className={cn(
                    "h-7 px-3 text-xs font-medium",
                    filters.medium === medium
                      ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {medium}
                </Button>
              ))}
            </div>

            {/* Standard selector */}
            <div className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-muted-foreground" />
              <Select
                value={filters.standardId.toString()}
                onValueChange={(value) => setFilters({ standardId: parseInt(value, 10) })}
              >
                <SelectTrigger className="w-44 bg-input">
                  <SelectValue placeholder="Select standard" />
                </SelectTrigger>
                <SelectContent>
                  {STANDARD_GROUPS.map((group) => (
                    <SelectGroup key={group}>
                      <SelectLabel className="text-xs font-medium text-muted-foreground">
                        {group}
                      </SelectLabel>
                      {STANDARDS.filter((s) => s.standard_group === group).map(
                        (standard) => (
                          <SelectItem
                            key={standard.standard_id}
                            value={standard.standard_id.toString()}
                          >
                            {standard.standard_name}
                          </SelectItem>
                        )
                      )}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </div>

          {/* Year & summary */}
          <div className="flex flex-wrap items-center justify-start gap-3 text-sm text-muted-foreground md:justify-end">
            {/* Academic Year selector (compact) */}
            <div className="flex items-center gap-2">
              <span className="hidden text-xs font-medium text-muted-foreground md:inline">
                Academic year
              </span>
              <Select
                value={filters.academicYear}
                onValueChange={(value) => setFilters({ academicYear: value })}
              >
                <SelectTrigger className="h-8 w-28 bg-input text-xs">
                  <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent>
                  {ACADEMIC_YEARS.slice()
                    .reverse()
                    .map((y) => (
                      <SelectItem key={y} value={y}>
                        {y}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <span className="whitespace-nowrap text-xs md:text-sm">
              <span className="font-medium text-foreground">{schoolCount}</span>{" "}
              schools match your selection
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
