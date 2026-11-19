package mcpserver

import (
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

// schemaRule refines one property of an inferred input schema: the struct tags only carry
// descriptions, while enums and bounds tell a model which values are valid before it calls.
type schemaRule func(properties map[string]*jsonschema.Schema)

// schemaFor infers the schema of T and applies the rules. A rule naming a property the type
// does not have is a programming error and stops the process at start-up.
func schemaFor[T any](rules ...schemaRule) *jsonschema.Schema {
	schema, err := jsonschema.For[T](nil)
	if err != nil {
		panic(fmt.Sprintf("mcpserver: input schema of %T: %v", *new(T), err))
	}
	for _, rule := range rules {
		rule(schema.Properties)
	}
	return schema
}

func property(properties map[string]*jsonschema.Schema, name string) *jsonschema.Schema {
	schema, ok := properties[name]
	if !ok {
		panic("mcpserver: input schema has no property " + name)
	}
	return schema
}

// enum restricts a string property to values.
func enum(name string, values ...string) schemaRule {
	return func(properties map[string]*jsonschema.Schema) {
		schema := property(properties, name)
		schema.Enum = make([]any, 0, len(values))
		for _, value := range values {
			schema.Enum = append(schema.Enum, value)
		}
	}
}

// bounds sets the inclusive minimum and, when max is not zero, the inclusive maximum of a
// numeric property.
func bounds(name string, min, max float64) schemaRule {
	return func(properties map[string]*jsonschema.Schema) {
		schema := property(properties, name)
		schema.Minimum = &min
		if max != 0 {
			schema.Maximum = &max
		}
	}
}

// minLength sets the shortest accepted string.
func minLength(name string, length int) schemaRule {
	return func(properties map[string]*jsonschema.Schema) {
		property(properties, name).MinLength = &length
	}
}

// pattern restricts a string property to a regular expression.
func pattern(name, expression string) schemaRule {
	return func(properties map[string]*jsonschema.Schema) {
		property(properties, name).Pattern = expression
	}
}

// date marks a string property as an ISO date.
func date(name string) schemaRule {
	return func(properties map[string]*jsonschema.Schema) {
		property(properties, name).Format = "date"
	}
}
